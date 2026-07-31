import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { DomainError } from '../../domain/errors.ts'
import type {
  DetectedMediaColor,
} from '../../domain/color-and-export.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static') as { path?: string }
const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const producerCache = new Map<string, Promise<Readonly<{
  provider: 'ffprobe'
  version: 'json-v1'
  binaryDigest: string
}>>>()

export interface VideoProbeResult {
  width: number
  height: number
  fps: number
  duration: number
  codec: string
  audioCodec: string
  container: string
  color: DetectedMediaColor
  producer: Readonly<{
    provider: 'ffprobe'
    version: 'json-v1'
    binaryDigest: string
  }>
}

function parseRate(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0
  const [numerator, denominator = '1'] = value.split('/')
  const top = Number(numerator)
  const bottom = Number(denominator)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0
  return top / bottom
}

function positiveNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function token(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(normalized)
    ? normalized
    : undefined
}

function bitDepth(stream: Record<string, unknown>): number | undefined {
  const declared = Number(stream.bits_per_raw_sample)
  if (
    Number.isSafeInteger(declared) &&
    declared >= 8 &&
    declared <= 32
  ) return declared
  const pixelFormat = token(stream.pix_fmt)
  const matched = pixelFormat?.match(/(?:p|le|be)(\d{2})(?:le|be)?$/)
  if (matched) {
    const parsed = Number(matched[1])
    if (parsed >= 8 && parsed <= 32) return parsed
  }
  return pixelFormat ? 8 : undefined
}

function detectedColor(
  video: Record<string, unknown>,
): DetectedMediaColor {
  const matrix = token(video.color_space)
  const transfer = token(video.color_transfer)
  const primaries = token(video.color_primaries)
  const pixelFormat = token(video.pix_fmt)
  const depth = bitDepth(video)
  const rawRange = token(video.color_range)
  const range = rawRange === 'pc' || rawRange === 'jpeg'
    ? 'full' as const
    : rawRange === 'tv' || rawRange === 'mpeg'
      ? 'limited' as const
      : undefined
  const missing = [
    ...(!matrix ? ['missing-matrix'] : []),
    ...(!transfer ? ['missing-transfer'] : []),
    ...(!primaries ? ['missing-primaries'] : []),
    ...(!range ? ['missing-range'] : []),
    ...(!depth ? ['missing-bit-depth'] : []),
    ...(!pixelFormat ? ['missing-pixel-format'] : []),
  ]
  if (
    missing.length ||
    !matrix ||
    !transfer ||
    !primaries ||
    !range ||
    !depth ||
    !pixelFormat
  ) {
    return Object.freeze({
      state: 'unavailable' as const,
      ...(pixelFormat ? { pixelFormat } : {}),
      reasons: Object.freeze(missing),
    })
  }
  const colorSpace = primaries === 'bt709'
    ? 'rec709'
    : primaries.startsWith('bt2020')
      ? 'rec2020'
      : primaries === 'smpte432'
        ? 'display-p3'
        : `primaries-${primaries}`
  const hdrMode = transfer === 'smpte2084'
    ? 'pq' as const
    : transfer === 'arib-std-b67'
      ? 'hlg' as const
      : 'sdr' as const
  return Object.freeze({
    state: 'ready' as const,
    metadata: Object.freeze({
      colorSpace,
      transfer,
      primaries,
      matrix,
      range,
      bitDepth: depth,
    }),
    pixelFormat,
    hdrMode,
  })
}

function resolveBinary(environment: NodeJS.ProcessEnv): string {
  const configured = environment.FFPROBE_PATH?.trim()
  if (configured) return configured
  const bundled = typeof ffprobeStatic?.path === 'string' ? ffprobeStatic.path.trim() : ''
  return bundled || 'ffprobe'
}

function describeProducer(binary: string) {
  const cached = producerCache.get(binary)
  if (cached) return cached
  const pending = (async () => {
    const binaryDigest = isAbsolute(binary)
      ? await calculateFileSha256(binary)
      : createHash('sha256')
          .update((await execFileAsync(binary, ['-version'], {
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: 'utf8',
          })).stdout)
          .digest('hex')
    return Object.freeze({
      provider: 'ffprobe' as const,
      version: 'json-v1' as const,
      binaryDigest,
    })
  })()
  producerCache.set(binary, pending)
  pending.catch(() => producerCache.delete(binary))
  return pending
}

export async function probeVideo(
  filePath: string,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    environment?: NodeJS.ProcessEnv
    requireAudio?: boolean
  } = {},
): Promise<Readonly<VideoProbeResult>> {
  if (!isAbsolute(filePath)) {
    throw new DomainError('INVALID_ARGUMENT', 'Video probe path must be absolute')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
    throw new DomainError('INVALID_ARGUMENT', 'Video probe timeout is invalid')
  }
  if (options.signal?.aborted) {
    throw new DomainError('RENDER_EXECUTION_FAILED', 'Video probe was cancelled')
  }

  let stdout: string
  let producer: Awaited<ReturnType<typeof describeProducer>>
  const binary = resolveBinary(options.environment ?? process.env)
  try {
    const [result, descriptor] = await Promise.all([
      execFileAsync(binary, [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,pix_fmt,bits_per_raw_sample,color_space,color_transfer,color_primaries,color_range',
        '-of', 'json',
        filePath,
      ], {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: options.signal,
        encoding: 'utf8',
      }),
      describeProducer(binary),
    ])
    stdout = result.stdout
    producer = descriptor
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const message = code === 'ABORT_ERR'
      ? 'Video probe was cancelled'
      : code === 'ETIMEDOUT'
        ? 'Video probe exceeded its timeout'
        : 'Video probe failed'
    throw new DomainError('RENDER_OUTPUT_INVALID', message)
  }

  let payload: {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Video probe returned invalid JSON')
  }
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  const width = positiveNumber(video?.width)
  const height = positiveNumber(video?.height)
  const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate)
  const duration = positiveNumber(payload.format?.duration) || positiveNumber(video?.duration)
  const codec = typeof video?.codec_name === 'string' ? video.codec_name.trim() : ''
  const audioCodec = typeof audio?.codec_name === 'string' ? audio.codec_name.trim() : ''
  const formatName = typeof payload.format?.format_name === 'string'
    ? payload.format.format_name.trim()
    : ''
  const requireAudio = options.requireAudio ?? true
  if (
    !width ||
    !height ||
    !fps ||
    !duration ||
    !codec ||
    (requireAudio && !audioCodec) ||
    !formatName
  ) {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Video probe metadata is incomplete')
  }
  return Object.freeze({
    width,
    height,
    fps,
    duration,
    codec,
    audioCodec,
    container: formatName,
    color: detectedColor(video!),
    producer,
  })
}
