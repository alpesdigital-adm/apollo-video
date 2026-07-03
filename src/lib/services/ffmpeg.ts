/**
 * FFmpeg service for video processing operations.
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { promisify } from 'util'
import type { Silence } from '../types/project'
import { FPS } from '../types/timing'
import { parseSilenceDetection } from '../utils/silence'

const execFileAsync = promisify(execFile)

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
  outputPath: string
): Promise<VideoInfo> {
  try {
    await execFileAsync(ffmpegPath, [
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
      outputPath
    ])

    return getVideoInfo(outputPath)
  } catch (error) {
    throw new Error(`Failed to normalize video: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function generatePreviewProxy(
  inputPath: string,
  outputPath: string
): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, [
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
      outputPath
    ])
  } catch (error) {
    throw new Error(`Failed to generate preview proxy: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function getAudioEncodeArgs(outputPath: string): string[] {
  const extension = path.extname(outputPath).toLowerCase()

  if (extension === '.flac') {
    return ['-c:a', 'flac', '-compression_level', '8']
  }

  return ['-acodec', 'pcm_s16le']
}

export async function extractAudio(videoPath: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, [
      '-i',
      videoPath,
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      ...getAudioEncodeArgs(outputPath),
      '-y',
      outputPath
    ])
  } catch (error) {
    throw new Error(`Failed to extract audio: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function detectSilences(
  audioPath: string,
  threshold: number = -35,
  duration: number = 0.55
): Promise<Silence[]> {
  try {
    let stderr = ''

    try {
      const result = await execFileAsync(ffmpegPath, [
        '-i',
        audioPath,
        '-af',
        `silencedetect=n=${threshold}dB:d=${duration}`,
        '-f',
        'null',
        '-'
      ])
      stderr = result.stderr || ''
    } catch (error) {
      stderr = error instanceof Error && 'stderr' in error ? String((error as any).stderr || '') : ''
    }

    return parseSilenceDetection(stderr, FPS)
  } catch (error) {
    throw new Error(`Failed to detect silences: ${error instanceof Error ? error.message : String(error)}`)
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
  sourceDuration: number
): Promise<AutoCutResult> {
  const cutSilences = selectAutoCutSilences(silences)
  const sameInputOutput = path.resolve(inputPath) === path.resolve(outputPath)

  if (sameInputOutput) {
    const outputInfo = await getVideoInfo(outputPath)
    return { cutSilences, outputDuration: outputInfo.duration || sourceDuration }
  }

  if (cutSilences.length === 0) {
    await execFileAsync(ffmpegPath, ['-i', inputPath, '-c', 'copy', '-y', outputPath])
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

  await execFileAsync(ffmpegPath, [
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
    outputPath
  ])

  const outputInfo = await getVideoInfo(outputPath)
  return { cutSilences, outputDuration: outputInfo.duration }
}

export async function extractThumbnail(
  videoPath: string,
  atSeconds: number,
  outputPath: string,
  width: number = 180
): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, [
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
      outputPath
    ])
  } catch (error) {
    throw new Error(`Failed to extract thumbnail: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration,r_frame_rate:format=duration',
      '-of',
      'json',
      videoPath
    ])

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
    throw new Error(`Failed to get video info: ${error instanceof Error ? error.message : String(error)}`)
  }
}
