/**
 * FFmpeg service for video processing operations
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Silence } from '../types/project'
import { FPS } from '../types/timing'
import { parseSilenceDetection } from '../utils/silence'

const execFileAsync = promisify(execFile)

export interface VideoInfo {
  width: number
  height: number
  duration: number
  fps: number
}

/**
 * Normalize a video file for consistent processing
 * Converts to H.264, 30fps CFR, with proper keyframe settings
 * @param inputPath Path to input video file
 * @param outputPath Path to output normalized video
 * @returns Video metadata (duration in seconds, width, height, fps)
 */
export async function normalizeVideo(
  inputPath: string,
  outputPath: string
): Promise<VideoInfo> {
  try {
    // Run ffmpeg with normalization settings
    const command = 'ffmpeg'
    const args = [
      '-i',
      inputPath,
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
    ]

    await execFileAsync(command, args)

    // Get video info after normalization
    const info = await getVideoInfo(outputPath)
    return info
  } catch (error) {
    throw new Error(`Failed to normalize video: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Extract audio from a video file as WAV for Whisper processing
 * @param videoPath Path to input video file
 * @param outputPath Path to output WAV file
 */
export async function extractAudio(videoPath: string, outputPath: string): Promise<void> {
  try {
    const command = 'ffmpeg'
    const args = [
      '-i',
      videoPath,
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-y',
      outputPath
    ]

    await execFileAsync(command, args)
  } catch (error) {
    throw new Error(`Failed to extract audio: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Detect silence in audio using ffmpeg silencedetect filter
 * @param audioPath Path to audio file
 * @param threshold Silence threshold in dB (default -40)
 * @param duration Minimum silence duration in seconds (default 0.8)
 * @returns Array of Silence objects with timing and frame information
 */
export async function detectSilences(
  audioPath: string,
  threshold: number = -40,
  duration: number = 0.8
): Promise<Silence[]> {
  try {
    const command = 'ffmpeg'
    const args = [
      '-i',
      audioPath,
      '-af',
      `silencedetect=n=${threshold}dB:d=${duration}`,
      '-f',
      'null',
      '-'
    ]

    try {
      await execFileAsync(command, args)
    } catch (error) {
      // ffmpeg returns exit code 1 for null output, but stderr contains the silencedetect output
      // This is expected behavior
    }

    // Get stderr from the error (contains silencedetect output)
    if (error instanceof Error && 'stderr' in error) {
      const stderr = (error as any).stderr || ''
      return parseSilenceDetection(stderr, FPS)
    }

    return []
  } catch (error) {
    throw new Error(`Failed to detect silences: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Get video information using ffprobe
 * @param videoPath Path to video file
 * @returns Video metadata including dimensions, duration, and fps
 */
export async function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  try {
    const command = 'ffprobe'
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration,r_frame_rate',
      '-of',
      'default=noprint_wrappers=1:nokey=1:noprint_wrappers=1',
      videoPath
    ]

    const { stdout } = await execFileAsync(command, args)
    const lines = stdout.trim().split('\n')

    if (lines.length < 4) {
      throw new Error('Unexpected ffprobe output format')
    }

    const width = parseInt(lines[0], 10)
    const height = parseInt(lines[1], 10)
    const duration = parseFloat(lines[2])

    // Parse frame rate (format: "30/1" or "24000/1001")
    const frameRateParts = lines[3].split('/')
    const fps =
      frameRateParts.length === 2
        ? parseInt(frameRateParts[0], 10) / parseInt(frameRateParts[1], 10)
        : 30

    if (isNaN(width) || isNaN(height) || isNaN(duration) || isNaN(fps)) {
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
