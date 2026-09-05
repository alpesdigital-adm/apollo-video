import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import {
  COLOR_MEASUREMENT_UNITS,
  createCameraColorMeasurement,
  type CameraColorMeasurement,
  type ColorEvaluatorRef,
  type ColorMeasurementDimension,
  type ColorMeasurementDimensionResult,
} from '../../domain/color-measurement.ts'
import { DomainError } from '../../domain/errors.ts'
import type { TickInterval } from '../../domain/session-time.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

/**
 * Decoded-frame colour statistics with real FFmpeg (F4.013/F4.014).
 *
 * Method, chosen and documented here: FFmpeg decodes each requested range,
 * subsamples it in time with the `fps` filter, scales every frame to 64×36
 * and hands raw `rgb24` bytes over a pipe. The statistics are computed in
 * Node over those bytes. `signalstats` was the alternative; it reports
 * per-frame averages but not channel ratios, percentiles or a skin band, and
 * those are what a match and a critic are built from.
 *
 * All quantities are in the encoded (display-referred) domain FFmpeg hands
 * back after its own YUV→RGB and limited→full expansion. That is an
 * approximation, and a deliberate one: the corrector this feeds
 * (`colorchannelmixer`/`eq` in the `match` stage) operates in the same
 * domain, so a ratio measured here is a gain that can be applied there
 * without a second conversion nobody has verified.
 *
 * The skin dimension is a YCbCr band mask — Cb 77–127, Cr 133–173 (JFIF
 * scaling), with a minimum area. It is a deterministic stand-in for a skin
 * model that is not deployed, and is therefore a `controlled` evaluator: it
 * can say "pixels in the skin band", never "skin".
 */

export const FFMPEG_COLOR_MEASUREMENT_VERSION = '1.0.0' as const
export const COLOR_SAMPLE_WIDTH = 64
export const COLOR_SAMPLE_HEIGHT = 36
const SAMPLE_BYTES = COLOR_SAMPLE_WIDTH * COLOR_SAMPLE_HEIGHT * 3
const MAX_SAMPLED_FRAMES = 2_000
const DEFAULT_SAMPLE_EVERY_MS = 250
const DEFAULT_TIMEOUT_MS = 60_000
/** Frames at which the measurement confidence reaches 1. */
const TARGET_FRAMES = 8

/** Luma at or below this is crushed; at or above the other, clipped. 8-bit levels over 255. */
export const COLOR_CRUSH_THRESHOLD = 4 / 255
export const COLOR_CLIP_THRESHOLD = 251 / 255
/** JFIF YCbCr skin band (Chai & Ngan) and the area below which nothing is claimed. */
export const SKIN_BAND = Object.freeze({ cbMin: 77, cbMax: 127, crMin: 133, crMax: 173 })
export const SKIN_MINIMUM_AREA_RATIO = 0.02

export const COLOR_STATISTICS_EVALUATOR: Readonly<ColorEvaluatorRef> = Object.freeze({
  id: 'ffmpeg-rgb24-statistics',
  kind: 'measured',
  version: FFMPEG_COLOR_MEASUREMENT_VERSION,
})
export const SKIN_BAND_EVALUATOR: Readonly<ColorEvaluatorRef> = Object.freeze({
  id: 'ycbcr-skin-band-mask',
  kind: 'controlled',
  version: FFMPEG_COLOR_MEASUREMENT_VERSION,
})

export interface ColorMeasurementRangeRequest {
  /** Session ticks the range describes. */
  readonly sessionRange: Readonly<TickInterval>
  /** Source frame indices to decode, half-open. */
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
  readonly measurementId?: string
}

export interface MeasureCameraColorInput {
  readonly mediaPath: string
  readonly cameraId: string
  readonly sourceAssetId: string
  readonly sourceSha256: string
  readonly sessionId?: string | null
  readonly ranges: readonly Readonly<ColorMeasurementRangeRequest>[]
  readonly sampleEveryMs?: number
  readonly signal?: AbortSignal
}

interface FrameStatistics {
  frames: number
  pixels: number
  sumR: number
  sumG: number
  sumB: number
  sumLuma: number
  sumChroma: number
  crushed: number
  clipped: number
  luma: Float32Array
  skinCount: number
  skinSumY: number
  skinSumCb: number
  skinSumCr: number
}

function percentile(sorted: Float32Array, fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[index]!
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

function statistics(bytes: Uint8Array): FrameStatistics {
  const pixels = bytes.byteLength / 3
  const luma = new Float32Array(pixels)
  const result: FrameStatistics = {
    frames: bytes.byteLength / SAMPLE_BYTES,
    pixels,
    sumR: 0, sumG: 0, sumB: 0,
    sumLuma: 0, sumChroma: 0,
    crushed: 0, clipped: 0,
    luma,
    skinCount: 0, skinSumY: 0, skinSumCb: 0, skinSumCr: 0,
  }
  for (let index = 0; index < pixels; index += 1) {
    const r8 = bytes[index * 3]!
    const g8 = bytes[index * 3 + 1]!
    const b8 = bytes[index * 3 + 2]!
    const r = r8 / 255
    const g = g8 / 255
    const b = b8 / 255
    // BT.709 luma and Cb/Cr over the encoded RGB FFmpeg produced.
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const cb = (b - y) / 1.8556
    const cr = (r - y) / 1.5748
    luma[index] = y
    result.sumR += r
    result.sumG += g
    result.sumB += b
    result.sumLuma += y
    result.sumChroma += Math.sqrt(cb * cb + cr * cr)
    if (y <= COLOR_CRUSH_THRESHOLD) result.crushed += 1
    if (y >= COLOR_CLIP_THRESHOLD) result.clipped += 1
    // JFIF-scaled 8-bit Cb/Cr for the skin band.
    const cb8 = 128 - 0.168736 * r8 - 0.331264 * g8 + 0.5 * b8
    const cr8 = 128 + 0.5 * r8 - 0.418688 * g8 - 0.081312 * b8
    if (cb8 >= SKIN_BAND.cbMin && cb8 <= SKIN_BAND.cbMax && cr8 >= SKIN_BAND.crMin && cr8 <= SKIN_BAND.crMax) {
      result.skinCount += 1
      result.skinSumY += y
      result.skinSumCb += cb8
      result.skinSumCr += cr8
    }
  }
  return result
}

function measured(
  dimension: ColorMeasurementDimension,
  value: number,
  evidenceRef: string,
  evaluator: Readonly<ColorEvaluatorRef> = COLOR_STATISTICS_EVALUATOR,
  components?: Readonly<Record<string, number>>,
): Readonly<ColorMeasurementDimensionResult> {
  return Object.freeze({
    status: 'measured' as const,
    value: round6(value),
    unit: COLOR_MEASUREMENT_UNITS[dimension],
    evaluator,
    evidenceRef,
    ...(components
      ? { components: Object.freeze(Object.fromEntries(Object.entries(components).map(([key, nested]) => [key, round6(nested)]))) }
      : {}),
  })
}

function unavailable(reason: string): Readonly<ColorMeasurementDimensionResult> {
  return Object.freeze({ status: 'unavailable' as const, reason })
}

function notApplicable(reason: string): Readonly<ColorMeasurementDimensionResult> {
  return Object.freeze({ status: 'not-applicable' as const, reason })
}

function dimensionsFrom(stats: FrameStatistics, evidenceRef: string): Readonly<Record<ColorMeasurementDimension, Readonly<ColorMeasurementDimensionResult>>> {
  if (stats.pixels === 0) {
    const reason = 'FFmpeg produced no decodable frames inside the requested range'
    return Object.freeze({
      whiteBalance: unavailable(reason), exposure: unavailable(reason), contrast: unavailable(reason),
      blacks: unavailable(reason), highlights: unavailable(reason), saturation: unavailable(reason),
      tonalResponse: unavailable(reason), skin: unavailable(reason),
    })
  }
  const meanR = stats.sumR / stats.pixels
  const meanG = stats.sumG / stats.pixels
  const meanB = stats.sumB / stats.pixels
  const meanLuma = stats.sumLuma / stats.pixels
  let variance = 0
  for (let index = 0; index < stats.luma.length; index += 1) {
    const delta = stats.luma[index]! - meanLuma
    variance += delta * delta
  }
  const standardDeviation = Math.sqrt(variance / stats.pixels)
  const sorted = Float32Array.from(stats.luma).sort()
  const p1 = percentile(sorted, 0.01)
  const p5 = percentile(sorted, 0.05)
  const p25 = percentile(sorted, 0.25)
  const p50 = percentile(sorted, 0.5)
  const p75 = percentile(sorted, 0.75)
  const p95 = percentile(sorted, 0.95)
  const p99 = percentile(sorted, 0.99)

  // A gray-world estimate needs a green channel to divide by. Below one
  // 8-bit level the ratios are noise, and noise reported as a number would
  // be a white balance nobody measured.
  const whiteBalance = meanG > 1 / 255 && meanR > 1 / 255
    ? measured('whiteBalance', meanB / meanR, evidenceRef, COLOR_STATISTICS_EVALUATOR, {
        rOverG: meanR / meanG,
        bOverG: meanB / meanG,
        bOverR: meanB / meanR,
      })
    : unavailable('the decoded frames are too dark for a channel-ratio white balance estimate')

  const skinAreaRatio = stats.skinCount / stats.pixels
  const skin = skinAreaRatio >= SKIN_MINIMUM_AREA_RATIO
    ? measured(
        'skin',
        ((Math.atan2(stats.skinSumCr / stats.skinCount - 128, stats.skinSumCb / stats.skinCount - 128) * 180) / Math.PI + 360) % 360,
        evidenceRef,
        SKIN_BAND_EVALUATOR,
        {
          areaRatio: skinAreaRatio,
          meanY: stats.skinSumY / stats.skinCount,
          meanCb: stats.skinSumCb / stats.skinCount,
          meanCr: stats.skinSumCr / stats.skinCount,
        },
      )
    : notApplicable(`fewer than ${(SKIN_MINIMUM_AREA_RATIO * 100).toFixed(0)}% of sampled pixels fall in the skin band; no skin-band region to measure`)

  return Object.freeze({
    whiteBalance,
    exposure: measured('exposure', meanLuma, evidenceRef),
    contrast: measured('contrast', standardDeviation, evidenceRef, COLOR_STATISTICS_EVALUATOR, { p5, p95, spread: p95 - p5 }),
    blacks: measured('blacks', stats.crushed / stats.pixels, evidenceRef, COLOR_STATISTICS_EVALUATOR, { threshold: COLOR_CRUSH_THRESHOLD }),
    highlights: measured('highlights', stats.clipped / stats.pixels, evidenceRef, COLOR_STATISTICS_EVALUATOR, { threshold: COLOR_CLIP_THRESHOLD }),
    saturation: measured('saturation', stats.sumChroma / stats.pixels, evidenceRef),
    tonalResponse: measured('tonalResponse', p50, evidenceRef, COLOR_STATISTICS_EVALUATOR, { p1, p5, p25, p50, p75, p95, p99 }),
    skin,
  })
}

/**
 * Infrastructure class in the repository's plain-`node` style: fields are
 * declared and assigned in the constructor, never as parameter properties.
 */
export class FfmpegColorMeasurement {
  private readonly ffmpegPath: string
  private readonly timeoutMs: number

  constructor(options: { ffmpegPath?: string; timeoutMs?: number } = {}) {
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
      throw new DomainError('INVALID_ARGUMENT', 'Colour measurement timeout is invalid')
    }
    this.timeoutMs = timeoutMs
  }

  /**
   * One measurement per requested range. The bytes are verified against the
   * declared SHA-256 first — measuring a substituted file would produce a
   * confident number about a recording that is not the one in the session —
   * and an HDR source is refused rather than measured wrong.
   */
  async measureCameraColor(input: MeasureCameraColorInput): Promise<readonly Readonly<CameraColorMeasurement>[]> {
    if (!isAbsolute(input.mediaPath)) {
      throw new DomainError('INVALID_ARGUMENT', 'Colour measurement media path must be absolute')
    }
    if (!Array.isArray(input.ranges) || input.ranges.length === 0) {
      throw new DomainError('INVALID_ARGUMENT', 'Colour measurement needs at least one range')
    }
    const sampleEveryMs = input.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
    if (!Number.isFinite(sampleEveryMs) || sampleEveryMs < 20 || sampleEveryMs > 10_000) {
      throw new DomainError('INVALID_ARGUMENT', 'sampleEveryMs must be between 20 and 10000')
    }
    const actualSha256 = await calculateFileSha256(input.mediaPath)
    if (actualSha256 !== input.sourceSha256) {
      throw new DomainError(
        'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
        'The bytes at the media path are not the bytes the measurement was requested for',
        { expected: input.sourceSha256, actual: actualSha256 },
      )
    }
    const probe = await probeVideo(input.mediaPath, { signal: input.signal, timeoutMs: this.timeoutMs, requireAudio: false })
    if (probe.color.state !== 'ready') {
      throw new DomainError(
        'COLOR_SOURCES_INCOMPARABLE',
        'The source carries no complete colour metadata; its statistics could not be compared to any other camera',
        { reasons: probe.color.reasons },
      )
    }
    if (probe.color.hdrMode !== 'sdr') {
      throw new DomainError(
        'COLOR_HDR_SDR_UNSUPPORTED',
        `The source is ${probe.color.hdrMode}; the 8-bit RGB statistics this measurement takes are undefined without a tone-map, and none exists`,
        { hdrMode: probe.color.hdrMode, transfer: probe.color.metadata.transfer },
      )
    }
    const technical = Object.freeze({
      metadata: probe.color.metadata,
      pixelFormat: probe.color.pixelFormat,
      hdrMode: probe.color.hdrMode,
    })
    const sampleRate = 1_000 / sampleEveryMs

    const measurements: Readonly<CameraColorMeasurement>[] = []
    for (const range of input.ranges) {
      if (
        !Number.isSafeInteger(range.sourceStartFrame) || range.sourceStartFrame < 0 ||
        !Number.isSafeInteger(range.sourceEndFrame) || range.sourceEndFrame <= range.sourceStartFrame
      ) {
        throw new DomainError('INVALID_ARGUMENT', 'Colour measurement source range must be a forward frame range')
      }
      const startSeconds = range.sourceStartFrame / probe.fps
      const durationSeconds = (range.sourceEndFrame - range.sourceStartFrame) / probe.fps
      const expectedFrames = Math.min(MAX_SAMPLED_FRAMES, Math.max(1, Math.ceil(durationSeconds * sampleRate)))
      let bytes: Uint8Array
      try {
        const { stdout } = await execFileAsync(this.ffmpegPath, [
          '-hide_banner', '-nostdin', '-loglevel', 'error',
          '-ss', startSeconds.toFixed(6),
          '-t', durationSeconds.toFixed(6),
          '-i', input.mediaPath,
          '-map', '0:v:0', '-an',
          '-vf', `fps=${sampleRate.toFixed(6)},scale=${COLOR_SAMPLE_WIDTH}:${COLOR_SAMPLE_HEIGHT}:flags=area,format=rgb24`,
          '-frames:v', String(expectedFrames),
          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
        ], {
          encoding: 'buffer',
          windowsHide: true,
          timeout: this.timeoutMs,
          maxBuffer: (expectedFrames + 2) * SAMPLE_BYTES,
          signal: input.signal,
        })
        bytes = new Uint8Array(stdout)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        throw new DomainError(
          'RENDER_EXECUTION_FAILED',
          code === 'ABORT_ERR'
            ? 'Colour measurement was cancelled'
            : code === 'ETIMEDOUT'
              ? 'Colour measurement exceeded its timeout'
              : 'FFmpeg colour measurement failed',
          { cameraId: input.cameraId, sourceStartFrame: range.sourceStartFrame },
        )
      }
      if (bytes.byteLength % SAMPLE_BYTES !== 0) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'FFmpeg returned a partial colour sample frame')
      }
      const stats = statistics(bytes)
      const evidenceRef = `rawvideo-rgb24:${createHash('sha256').update(bytes).digest('hex')}`
      const measurementId = range.measurementId ?? `ccm-${createHash('sha256')
        .update(`${input.sourceSha256}|${input.cameraId}|${range.sourceStartFrame}|${range.sourceEndFrame}`)
        .digest('hex')
        .slice(0, 24)}`
      measurements.push(createCameraColorMeasurement({
        measurementId,
        sessionId: input.sessionId ?? null,
        sourceAssetId: input.sourceAssetId,
        sourceSha256: input.sourceSha256,
        cameraId: input.cameraId,
        range: range.sessionRange,
        sourceRange: { startFrame: range.sourceStartFrame, endFrame: range.sourceEndFrame },
        sampledFrames: stats.frames,
        technical,
        dimensions: dimensionsFrom(stats, evidenceRef),
        confidence: round6(Math.min(1, stats.frames / TARGET_FRAMES)),
        issues: stats.frames === 0
          ? [{ code: 'no-frames-decoded', message: 'FFmpeg decoded no frame inside the requested range' }]
          : [],
      }))
    }
    return Object.freeze(measurements)
  }
}
