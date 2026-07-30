import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { promisify } from 'node:util'

import type {
  ContiguousVisualEvidenceMeasurement,
  ContiguousVisualEvidenceProvider,
} from '../../application/ports/contiguous-visual-evidence-provider.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from '../media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const BYTE_SIZE = /^[1-9][0-9]{0,18}$/

function contained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate)
  return !nested.startsWith('..') && !isAbsolute(nested)
}

function artifactPath(root: string, artifactKey: string): string {
  if (
    !artifactKey ||
    artifactKey.length > 512 ||
    artifactKey.startsWith('/') ||
    artifactKey.includes('\\') ||
    artifactKey.split('/').some(
      (part) => !part || part === '.' || part === '..',
    )
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Contiguous visual artifact key is invalid',
    )
  }
  const candidate = join(root, ...artifactKey.split('/'))
  if (!contained(root, candidate)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Contiguous visual artifact escaped storage',
    )
  }
  return candidate
}

function rounded(value: number, decimals = 6): number {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

function values(output: string, field: string): number[] {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...output.matchAll(
    new RegExp(`${escaped}=(-?[0-9]+(?:\\.[0-9]+)?)`, 'g'),
  )].map((match) => Number(match[1]))
  if (
    matches.length === 0 ||
    matches.some((value) => !Number.isFinite(value))
  ) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      `FFmpeg contiguous visual ${field} is unavailable`,
    )
  }
  return matches
}

function average(input: readonly number[], scale = 1): number {
  return rounded(
    input.reduce((total, value) => total + value, 0) /
      input.length /
      scale,
  )
}

function durationTotal(
  output: string,
  field: string,
  durationMs: number,
): number {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const durations = [...output.matchAll(
    new RegExp(`${escaped}[:=]\\s*([0-9]+(?:\\.[0-9]+)?)`, 'g'),
  )].map((match) => Number(match[1]))
  if (durations.some((value) => !Number.isFinite(value))) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      `FFmpeg contiguous visual ${field} is invalid`,
    )
  }
  return Math.min(
    durationMs,
    Math.max(
      0,
      Math.round(
        durations.reduce((total, value) => total + value, 0) *
          1_000,
      ),
    ),
  )
}

function freezeDurationMs(
  output: string,
  durationMs: number,
): number {
  const completed = durationTotal(
    output,
    'lavfi.freezedetect.freeze_duration',
    durationMs,
  )
  const starts = [...output.matchAll(
    /lavfi\.freezedetect\.freeze_start[:=]\s*([0-9]+(?:\.[0-9]+)?)/g,
  )].map((match) => Number(match[1]))
  const ends = [...output.matchAll(
    /lavfi\.freezedetect\.freeze_end[:=]\s*([0-9]+(?:\.[0-9]+)?)/g,
  )].map((match) => Number(match[1]))
  if (
    starts.some((value) => !Number.isFinite(value)) ||
    ends.some((value) => !Number.isFinite(value))
  ) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'FFmpeg contiguous visual freeze evidence is invalid',
    )
  }
  const openStart = starts.length > ends.length
    ? starts.at(-1)
    : undefined
  const trailing = openStart === undefined
    ? 0
    : Math.max(0, durationMs - Math.round(openStart * 1_000))
  return Math.min(durationMs, completed + trailing)
}

function validateInput(
  input: Parameters<ContiguousVisualEvidenceProvider['measure']>[0],
): void {
  if (
    !HASH.test(input.sourceArtifactSha256) ||
    !BYTE_SIZE.test(input.sourceArtifactByteSize) ||
    !Number.isSafeInteger(input.sourceDurationMs) ||
    input.sourceDurationMs < 1_000 ||
    input.sourceDurationMs > 43_200_000 ||
    !Array.isArray(input.windows) ||
    input.windows.length === 0 ||
    input.windows.length > 10_000 ||
    new Set(input.windows.map((window) => window.momentId)).size !==
      input.windows.length ||
    input.windows.some((window) =>
      !ID.test(window.momentId) ||
      !Array.isArray(window.rangeMs) ||
      window.rangeMs.length !== 2 ||
      !Number.isSafeInteger(window.rangeMs[0]) ||
      !Number.isSafeInteger(window.rangeMs[1]) ||
      window.rangeMs[0] < 0 ||
      window.rangeMs[1] <= window.rangeMs[0] ||
      window.rangeMs[1] > input.sourceDurationMs,
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Contiguous visual measurement input is invalid',
    )
  }
}

export class FfmpegContiguousVisualEvidenceProvider
implements ContiguousVisualEvidenceProvider {
  private readonly artifactRoot: string
  private readonly ffmpegPath: string
  private readonly timeoutMs: number

  constructor(options: {
    artifactRoot: string
    ffmpegPath?: string
    timeoutMs?: number
  }) {
    this.artifactRoot = resolve(options.artifactRoot.trim())
    this.ffmpegPath =
      options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
    if (
      !options.artifactRoot.trim() ||
      !isAbsolute(this.artifactRoot) ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 10_000 ||
      this.timeoutMs > 60 * 60_000
    ) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Contiguous visual measurement is not configured',
      )
    }
  }

  async measure(
    input: Parameters<ContiguousVisualEvidenceProvider['measure']>[0],
  ): ReturnType<ContiguousVisualEvidenceProvider['measure']> {
    validateInput(input)
    if (input.signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous visual measurement was cancelled',
      )
    }
    const source = artifactPath(
      this.artifactRoot,
      input.sourceArtifactKey,
    )
    const metadata = await stat(source).catch(() => null)
    if (
      !metadata?.isFile() ||
      metadata.size.toString() !== input.sourceArtifactByteSize
    ) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        'Contiguous visual source bytes were not found',
      )
    }
    if (
      await calculateFileSha256(source) !==
        input.sourceArtifactSha256
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Contiguous visual source checksum does not match the catalog',
      )
    }

    const measurements: ContiguousVisualEvidenceMeasurement[] = []
    for (const window of input.windows) {
      if (input.signal.aborted) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Contiguous visual measurement was cancelled',
        )
      }
      const durationMs = window.rangeMs[1] - window.rangeMs[0]
      let output: string
      try {
        const result = await execFileAsync(
          this.ffmpegPath,
          [
            '-hide_banner',
            '-nostats',
            '-loglevel',
            'info',
            '-ss',
            (window.rangeMs[0] / 1_000).toFixed(3),
            '-t',
            (durationMs / 1_000).toFixed(3),
            '-i',
            source,
            '-map',
            '0:v:0',
            '-vf',
            'setpts=PTS-STARTPTS,signalstats=stat=tout+vrep+brng,scdet=threshold=10,metadata=mode=print,blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-50dB:d=0.5',
            '-an',
            '-f',
            'null',
            '-',
          ],
          {
            windowsHide: true,
            timeout: this.timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            signal: input.signal,
            encoding: 'utf8',
          },
        )
        output = `${result.stdout}\n${result.stderr}`
      } catch {
        throw new DomainError(
          input.signal.aborted
            ? 'VERSION_CONFLICT'
            : 'RENDER_EXECUTION_FAILED',
          input.signal.aborted
            ? 'Contiguous visual measurement was cancelled'
            : 'FFmpeg contiguous visual measurement failed',
        )
      }
      const luma = values(output, 'lavfi.signalstats.YAVG')
      const saturation = values(
        output,
        'lavfi.signalstats.SATAVG',
      )
      const temporalDifference = values(
        output,
        'lavfi.signalstats.YDIF',
      )
      const temporalOutliers = values(
        output,
        'lavfi.signalstats.TOUT',
      )
      const repeatedPixels = values(
        output,
        'lavfi.signalstats.VREP',
      )
      const broadcastRange = values(
        output,
        'lavfi.signalstats.BRNG',
      )
      if (
        ![
          saturation,
          temporalDifference,
          temporalOutliers,
          repeatedPixels,
          broadcastRange,
        ].every((items) => items.length === luma.length)
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'FFmpeg contiguous visual frame evidence is incomplete',
        )
      }
      const blackDurationMs = durationTotal(
        output,
        'black_duration',
        durationMs,
      )
      const frozenDurationMs = freezeDurationMs(output, durationMs)
      measurements.push(Object.freeze({
        momentId: window.momentId,
        rangeMs: Object.freeze([...window.rangeMs]) as
          readonly [number, number],
        durationMs,
        sampledFrameCount: luma.length,
        averageLuma: average(luma, 255),
        averageSaturation: average(saturation, 255),
        averageTemporalDifference:
          average(temporalDifference, 255),
        temporalOutlierRatio: average(temporalOutliers),
        repeatedPixelRatio: average(repeatedPixels),
        broadcastRangeViolationRatio: average(broadcastRange),
        blackDurationMs,
        blackRatio: rounded(blackDurationMs / durationMs),
        freezeDurationMs: frozenDurationMs,
        freezeRatio: rounded(frozenDurationMs / durationMs),
        sceneChangeCount: [
          ...output.matchAll(/lavfi\.scd\.time=/g),
        ].length,
      }))
    }
    if (
      await calculateFileSha256(source) !==
        input.sourceArtifactSha256
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Contiguous visual source changed during measurement',
      )
    }
    return Object.freeze(measurements)
  }
}

export function createFfmpegContiguousVisualEvidenceProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const artifactRoot =
    environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Artifact root is not configured',
    )
  }
  const timeoutMs = Number(
    environment.APOLLO_V2_CONTIGUOUS_VISUAL_TIMEOUT_MS,
  )
  return new FfmpegContiguousVisualEvidenceProvider({
    artifactRoot,
    ...(environment.APOLLO_V2_FFMPEG_PATH?.trim()
      ? { ffmpegPath: environment.APOLLO_V2_FFMPEG_PATH.trim() }
      : {}),
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
  })
}
