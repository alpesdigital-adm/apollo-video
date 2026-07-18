import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { DomainError } from '../../domain/errors.ts'

const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static') as { path?: string }
const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export interface VideoProbeResult {
  width: number
  height: number
  fps: number
  duration: number
  codec: string
  container: string
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

function resolveBinary(environment: NodeJS.ProcessEnv): string {
  const configured = environment.FFPROBE_PATH?.trim()
  if (configured) return configured
  const bundled = typeof ffprobeStatic?.path === 'string' ? ffprobeStatic.path.trim() : ''
  return bundled || 'ffprobe'
}

export async function probeVideo(
  filePath: string,
  options: { timeoutMs?: number; signal?: AbortSignal; environment?: NodeJS.ProcessEnv } = {},
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
  try {
    const result = await execFileAsync(
      resolveBinary(options.environment ?? process.env),
      [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration',
        '-of', 'json',
        filePath,
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: options.signal,
        encoding: 'utf8',
      },
    )
    stdout = result.stdout
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
  const width = positiveNumber(video?.width)
  const height = positiveNumber(video?.height)
  const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate)
  const duration = positiveNumber(payload.format?.duration) || positiveNumber(video?.duration)
  const codec = typeof video?.codec_name === 'string' ? video.codec_name.trim() : ''
  const formatName = typeof payload.format?.format_name === 'string'
    ? payload.format.format_name.split(',')[0]?.trim() ?? ''
    : ''
  if (!width || !height || !fps || !duration || !codec || !formatName) {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Video probe metadata is incomplete')
  }
  return Object.freeze({ width, height, fps, duration, codec, container: formatName })
}
