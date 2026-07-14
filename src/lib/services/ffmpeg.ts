/**
 * FFmpeg service for video processing operations.
 */

import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { rename, rm, stat } from 'fs/promises'
import path from 'path'
import type { Silence } from '../types/project.ts'
import { FPS } from '../types/timing.ts'
import { parseSilenceDetection } from '../utils/silence.ts'

const DEFAULT_FFMPEG_TIMEOUT_MS = 30 * 60_000
const DEFAULT_FFPROBE_TIMEOUT_MS = 60_000
const MAX_MEDIA_TIMEOUT_MS = 6 * 60 * 60_000
const DEFAULT_MEDIA_MAX_BUFFER_BYTES = 8 * 1024 * 1024
const MAX_MEDIA_BUFFER_BYTES = 64 * 1024 * 1024
const ERROR_OUTPUT_TAIL_LENGTH = 4_000

type MediaTool = 'ffmpeg' | 'ffprobe'

export type MediaProcessFailureCode =
  | 'MEDIA_PROCESS_CANCELLED'
  | 'MEDIA_PROCESS_TIMEOUT'
  | 'MEDIA_PROCESS_OUTPUT_LIMIT'
  | 'MEDIA_PROCESS_FAILED'

export interface MediaExecutionOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBufferBytes?: number
}

interface MediaProcessFailure extends Error {
  code?: string | number
  killed?: boolean
  signal?: string
  stderr?: string | Buffer
}

export class MediaProcessError extends Error {
  readonly code: MediaProcessFailureCode
  readonly tool: MediaTool
  readonly stderrTail: string

  constructor(
    code: MediaProcessFailureCode,
    tool: MediaTool,
    message: string,
    options: { cause?: unknown; stderrTail?: string } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'MediaProcessError'
    this.code = code
    this.tool = tool
    this.stderrTail = options.stderrTail ?? ''
  }
}

export type MediaOutputFailureCode =
  | 'MEDIA_OUTPUT_CONFLICT'
  | 'MEDIA_OUTPUT_INVALID'
  | 'MEDIA_OUTPUT_PROMOTION_FAILED'
  | 'MEDIA_OUTPUT_CLEANUP_FAILED'

export class MediaOutputError extends Error {
  readonly code: MediaOutputFailureCode

  constructor(code: MediaOutputFailureCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'MediaOutputError'
    this.code = code
  }
}

function assertDistinctMediaPaths(inputPath: string, outputPath: string): void {
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new MediaOutputError(
      'MEDIA_OUTPUT_CONFLICT',
      'Media input and output paths must be different'
    )
  }
}

function stagedMediaPath(outputPath: string): string {
  const parsed = path.parse(outputPath)
  return path.join(
    parsed.dir,
    `.${parsed.name}.${randomUUID()}.partial${parsed.ext}`
  )
}

async function validateStagedOutput(stagedPath: string): Promise<void> {
  try {
    const metadata = await stat(stagedPath)
    if (!metadata.isFile() || metadata.size <= 0) {
      throw new Error('staged output is empty')
    }
  } catch (error) {
    throw new MediaOutputError(
      'MEDIA_OUTPUT_INVALID',
      'Media process did not produce a valid output file',
      { cause: error }
    )
  }
}

async function materializeMediaOutput<T>(
  outputPath: string,
  writeStagedOutput: (stagedPath: string) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const stagedPath = stagedMediaPath(outputPath)

  try {
    const result = await writeStagedOutput(stagedPath)
    await validateStagedOutput(stagedPath)
    if (signal?.aborted) {
      throw new MediaProcessError(
        'MEDIA_PROCESS_CANCELLED',
        'ffmpeg',
        'ffmpeg execution was cancelled'
      )
    }
    try {
      await rename(stagedPath, outputPath)
    } catch (error) {
      throw new MediaOutputError(
        'MEDIA_OUTPUT_PROMOTION_FAILED',
        'Media output could not be promoted',
        { cause: error }
      )
    }
    return result
  } catch (error) {
    try {
      await rm(stagedPath, { force: true })
    } catch (cleanupError) {
      throw new MediaOutputError(
        'MEDIA_OUTPUT_CLEANUP_FAILED',
        'Partial media output could not be removed',
        { cause: { operationError: error, cleanupError } }
      )
    }
    throw error
  }
}

function boundedInteger(
  value: number | string | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(parsed)))
}

function defaultTimeoutMs(tool: MediaTool): number {
  return tool === 'ffmpeg'
    ? boundedInteger(process.env.FFMPEG_TIMEOUT_MS, DEFAULT_FFMPEG_TIMEOUT_MS, MAX_MEDIA_TIMEOUT_MS)
    : boundedInteger(process.env.FFPROBE_TIMEOUT_MS, DEFAULT_FFPROBE_TIMEOUT_MS, MAX_MEDIA_TIMEOUT_MS)
}

function failureCode(error: MediaProcessFailure): MediaProcessFailureCode {
  if (
    error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    error.message.toLowerCase().includes('maxbuffer')
  ) {
    return 'MEDIA_PROCESS_OUTPUT_LIMIT'
  }
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
    return 'MEDIA_PROCESS_CANCELLED'
  }
  if (error.code === 'ETIMEDOUT' || (error.killed && Boolean(error.signal))) {
    return 'MEDIA_PROCESS_TIMEOUT'
  }
  return 'MEDIA_PROCESS_FAILED'
}

function failureMessage(
  code: MediaProcessFailureCode,
  tool: MediaTool,
  timeoutMs: number,
  maxBufferBytes: number
): string {
  if (code === 'MEDIA_PROCESS_CANCELLED') return `${tool} execution was cancelled`
  if (code === 'MEDIA_PROCESS_TIMEOUT') return `${tool} exceeded the ${timeoutMs}ms timeout`
  if (code === 'MEDIA_PROCESS_OUTPUT_LIMIT') {
    return `${tool} exceeded the ${maxBufferBytes}-byte output limit`
  }
  return `${tool} execution failed`
}

async function executeMediaProcess(
  tool: MediaTool,
  executable: string,
  args: string[],
  options: MediaExecutionOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = boundedInteger(options.timeoutMs, defaultTimeoutMs(tool), MAX_MEDIA_TIMEOUT_MS)
  const maxBufferBytes = boundedInteger(
    options.maxBufferBytes,
    boundedInteger(
      process.env.MEDIA_PROCESS_MAX_BUFFER_BYTES,
      DEFAULT_MEDIA_MAX_BUFFER_BYTES,
      MAX_MEDIA_BUFFER_BYTES
    ),
    MAX_MEDIA_BUFFER_BYTES
  )

  if (options.signal?.aborted) {
    throw new MediaProcessError('MEDIA_PROCESS_CANCELLED', tool, `${tool} execution was cancelled`)
  }

  let timedOut = false
  const timeoutController = new AbortController()
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, timeoutMs)
  timeoutHandle.unref()
  const executionSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal

  try {
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let closed = false
      let callbackCompleted = false
      let callbackError: Error | null = null
      let stdout = ''
      let stderr = ''
      const finish = () => {
        if (!closed || !callbackCompleted) return
        if (callbackError) {
          Object.assign(callbackError, { stdout, stderr })
          reject(callbackError)
        } else {
          resolve({ stdout, stderr })
        }
      }
      const child = execFile(executable, args, {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        maxBuffer: maxBufferBytes,
        signal: executionSignal
      }, (error, processStdout, processStderr) => {
        callbackError = error
        stdout = processStdout
        stderr = processStderr
        callbackCompleted = true
        finish()
      })
      child.once('close', () => {
        closed = true
        finish()
      })
    })
  } catch (error) {
    const failure = error as MediaProcessFailure
    const code = timedOut
      ? 'MEDIA_PROCESS_TIMEOUT'
      : options.signal?.aborted
        ? 'MEDIA_PROCESS_CANCELLED'
        : failureCode(failure)
    const stderrTail = String(failure.stderr ?? '').slice(-ERROR_OUTPUT_TAIL_LENGTH)
    throw new MediaProcessError(
      code,
      tool,
      failureMessage(code, tool, timeoutMs, maxBufferBytes),
      { cause: error, stderrTail }
    )
  } finally {
    clearTimeout(timeoutHandle)
  }
}

function runFfmpeg(
  args: string[],
  options: MediaExecutionOptions = {},
  logLevel: 'error' | 'info' = 'error'
): Promise<{ stdout: string; stderr: string }> {
  return executeMediaProcess(
    'ffmpeg',
    ffmpegPath,
    ['-hide_banner', '-nostdin', '-nostats', '-loglevel', logLevel, ...args],
    options
  )
}

function runFfprobe(
  args: string[],
  options: MediaExecutionOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return executeMediaProcess('ffprobe', ffprobePath, args, options)
}

function rethrowMediaError(context: string, error: unknown): never {
  if (error instanceof MediaProcessError || error instanceof MediaOutputError) throw error
  throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error
  })
}

function resolveExecutablePath(
  envName: string,
  candidates: string[],
  fallback: string
): string {
  const envPath = process.env[envName]
  if (envPath && existsSync(envPath)) {
    return envPath
  }

  const executablePath = candidates.find((candidate) => existsSync(candidate))
  return executablePath || fallback
}

const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const ffmpegPath = resolveExecutablePath(
  'FFMPEG_PATH',
  [
    path.join(
      process.cwd(),
      'node_modules',
      'ffmpeg-static',
      `ffmpeg${executableSuffix}`
    )
  ],
  'ffmpeg'
)
const ffprobePath = resolveExecutablePath(
  'FFPROBE_PATH',
  [
    path.join(
      process.cwd(),
      'node_modules',
      'ffprobe-static',
      'bin',
      process.platform,
      process.arch,
      `ffprobe${executableSuffix}`
    )
  ],
  'ffprobe'
)

export interface VideoInfo {
  width: number
  height: number
  duration: number
  fps: number
}

export interface AutoCutResult {
  cutSilences: Silence[]
  outputDuration: number
}

export async function normalizeVideo(
  inputPath: string,
  outputPath: string,
  options: MediaExecutionOptions = {}
): Promise<VideoInfo> {
  assertDistinctMediaPaths(inputPath, outputPath)
  try {
    return await materializeMediaOutput(outputPath, async (stagedPath) => {
      await runFfmpeg([
        '-i',
        inputPath,
        // Downscale para o budget da composição (lado menor <= 1080, aspecto preservado).
        // Sem isso, fontes 4K atravessam o pipeline inteiro e estouram memória
        // no autocut, no preview do browser e no cache de frames do Remotion.
        '-vf',
        "scale=w='if(gte(ih,iw),min(iw,1080),-2)':h='if(gte(ih,iw),-2,min(ih,1080))':flags=lanczos",
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-r',
        '30',
        '-g',
        '30',
        '-keyint_min',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-y',
        stagedPath
      ], options)

      return getVideoInfo(stagedPath, options)
    }, options.signal)
  } catch (error) {
    rethrowMediaError('Failed to normalize video', error)
  }
}

export async function generatePreviewProxy(
  inputPath: string,
  outputPath: string,
  options: MediaExecutionOptions = {}
): Promise<void> {
  assertDistinctMediaPaths(inputPath, outputPath)
  try {
    await materializeMediaOutput(outputPath, async (stagedPath) => {
      await runFfmpeg([
        '-i',
        inputPath,
        // Downscale para um proxy leve de preview (lado menor <= 720, aspecto
        // preservado). O render continua usando o arquivo de trabalho 1080p;
        // isto é só para o player do navegador não sufocar com arquivos pesados.
        '-vf',
        "scale=w='if(gte(ih,iw),min(iw,720),-2)':h='if(gte(ih,iw),-2,min(ih,720))':flags=lanczos",
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '30',
        '-r',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-movflags',
        '+faststart',
        '-y',
        stagedPath
      ], options)
      await getVideoInfo(stagedPath, options)
    }, options.signal)
  } catch (error) {
    rethrowMediaError('Failed to generate preview proxy', error)
  }
}

function getAudioEncodeArgs(outputPath: string): string[] {
  const extension = path.extname(outputPath).toLowerCase()

  if (extension === '.flac') {
    return ['-c:a', 'flac', '-compression_level', '8']
  }

  return ['-acodec', 'pcm_s16le']
}

export async function extractAudio(
  videoPath: string,
  outputPath: string,
  options: MediaExecutionOptions = {}
): Promise<void> {
  assertDistinctMediaPaths(videoPath, outputPath)
  try {
    await materializeMediaOutput(outputPath, async (stagedPath) => {
      await runFfmpeg([
        '-i',
        videoPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        ...getAudioEncodeArgs(stagedPath),
        '-y',
        stagedPath
      ], options)
    }, options.signal)
  } catch (error) {
    rethrowMediaError('Failed to extract audio', error)
  }
}

export async function detectSilences(
  audioPath: string,
  threshold: number = -35,
  duration: number = 0.55,
  options: MediaExecutionOptions = {}
): Promise<Silence[]> {
  try {
    const { stderr } = await runFfmpeg([
      '-i',
      audioPath,
      '-af',
      `silencedetect=n=${threshold}dB:d=${duration}`,
      '-f',
      'null',
      '-'
    ], options, 'info')
    return parseSilenceDetection(stderr, FPS)
  } catch (error) {
    rethrowMediaError('Failed to detect silences', error)
  }
}

// Margin (seconds) shaved off both edges of a silence before it becomes a
// cut, so speech immediately adjacent to the silence never gets clipped.
// Exported so callers computing cut boundaries ahead of time (e.g. retake
// removal) can account for this shrink instead of being silently undone by it.
export const AUTOCUT_MARGIN = 0.12

export function selectAutoCutSilences(
  silences: Silence[],
  options: { minDuration?: number; margin?: number } = {}
): Silence[] {
  const minDuration = options.minDuration ?? 0.55
  const margin = options.margin ?? AUTOCUT_MARGIN

  return silences
    .filter((silence) => silence.duration >= minDuration + margin * 2)
    .map((silence) => {
      const startTime = silence.startTime + margin
      const endTime = silence.endTime - margin
      const duration = Math.max(0, endTime - startTime)

      return {
        startTime,
        endTime,
        startFrame: Math.round(startTime * FPS),
        endFrame: Math.round(endTime * FPS),
        duration
      }
    })
    .filter((silence) => silence.duration >= 0.25)
}

export async function cutSilencesFromVideo(
  inputPath: string,
  outputPath: string,
  silences: Silence[],
  sourceDuration: number,
  options: MediaExecutionOptions = {}
): Promise<AutoCutResult> {
  const cutSilences = selectAutoCutSilences(silences)
  const sameInputOutput = path.resolve(inputPath) === path.resolve(outputPath)

  if (sameInputOutput) {
    const outputInfo = await getVideoInfo(outputPath, options)
    return { cutSilences, outputDuration: outputInfo.duration || sourceDuration }
  }

  if (cutSilences.length === 0) {
    await materializeMediaOutput(
      outputPath,
      (stagedPath) => runFfmpeg(['-i', inputPath, '-c', 'copy', '-y', stagedPath], options),
      options.signal
    )
    return { cutSilences: [], outputDuration: sourceDuration }
  }

  const keepRanges: Array<{ start: number; end: number }> = []
  let cursor = 0

  for (const silence of cutSilences) {
    if (silence.startTime > cursor) {
      keepRanges.push({ start: cursor, end: silence.startTime })
    }
    cursor = Math.max(cursor, silence.endTime)
  }

  if (cursor < sourceDuration) {
    keepRanges.push({ start: cursor, end: sourceDuration })
  }

  const ranges = keepRanges.filter((range) => range.end - range.start >= 0.05)
  if (ranges.length === 0) {
    throw new Error('Auto-cut would remove the entire video')
  }

  const filters: string[] = []
  const concatInputs: string[] = []

  ranges.forEach((range, index) => {
    filters.push(
      `[0:v]trim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`
    )
    filters.push(
      `[0:a]atrim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`
    )
    concatInputs.push(`[v${index}][a${index}]`)
  })

  filters.push(`${concatInputs.join('')}concat=n=${ranges.length}:v=1:a=1[outv][outa]`)

  const outputInfo = await materializeMediaOutput(outputPath, async (stagedPath) => {
    await runFfmpeg([
      '-i',
      inputPath,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[outv]',
      '-map',
      '[outa]',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '22',
      '-r',
      '30',
      '-g',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-y',
      stagedPath
    ], options)

    return getVideoInfo(stagedPath, options)
  }, options.signal)
  return { cutSilences, outputDuration: outputInfo.duration }
}

export async function extractThumbnail(
  videoPath: string,
  atSeconds: number,
  outputPath: string,
  width: number = 180,
  options: MediaExecutionOptions = {}
): Promise<void> {
  assertDistinctMediaPaths(videoPath, outputPath)
  try {
    await materializeMediaOutput(outputPath, async (stagedPath) => {
      await runFfmpeg([
        '-ss',
        Math.max(0, atSeconds).toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2`,
        '-q:v',
        '5',
        '-y',
        stagedPath
      ], options)
    }, options.signal)
  } catch (error) {
    rethrowMediaError('Failed to extract thumbnail', error)
  }
}

export async function getVideoInfo(
  videoPath: string,
  options: MediaExecutionOptions = {}
): Promise<VideoInfo> {
  try {
    const { stdout } = await runFfprobe([
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration,r_frame_rate:format=duration',
      '-of',
      'json',
      videoPath
    ], options)

    const data = JSON.parse(stdout)
    const stream = data.streams?.[0]
    if (!stream) {
      throw new Error('No video stream found')
    }

    const [fpsNum, fpsDen] = String(stream.r_frame_rate || '30/1')
      .split('/')
      .map((part) => Number(part))

    const width = Number(stream.width)
    const height = Number(stream.height)
    const duration = Number(stream.duration || data.format?.duration)
    const fps = fpsDen ? fpsNum / fpsDen : fpsNum || FPS

    if (!width || !height || !duration || !fps) {
      throw new Error('Failed to parse video metadata')
    }

    return {
      width,
      height,
      duration,
      fps: Math.round(fps)
    }
  } catch (error) {
    rethrowMediaError('Failed to get video info', error)
  }
}
