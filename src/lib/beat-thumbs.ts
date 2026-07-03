/**
 * Per-beat thumbnails: one JPEG per subtitle/legenda, extracted from the
 * project's video a beat past the caption start so the frame shows the
 * speaker mid-word instead of a silence/entry pose.
 */

import { existsSync } from 'fs'
import { mkdir, readdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { extractThumbnail } from './services/ffmpeg'
import type { SubtitleEntry } from './types/project'

const THUMB_OFFSET_SECONDS = 0.15
const THUMB_WIDTH = 180

export function beatThumbsDir(projectId: string): string {
  return path.join(process.cwd(), 'public', 'thumbs', projectId)
}

export function beatThumbFileName(index: number): string {
  return `beat_${index}.jpg`
}

async function isUpToDate(
  dir: string,
  expectedCount: number,
  updatedAtMs: number
): Promise<boolean> {
  if (expectedCount === 0 || !existsSync(dir)) {
    return false
  }

  try {
    const entries = await readdir(dir)
    const thumbCount = entries.filter((entry) => /^beat_\d+\.jpg$/.test(entry)).length
    if (thumbCount !== expectedCount) {
      return false
    }

    const firstThumbPath = path.join(dir, beatThumbFileName(0))
    if (!existsSync(firstThumbPath)) {
      return false
    }

    const info = await stat(firstThumbPath)
    return info.mtimeMs > updatedAtMs
  } catch {
    return false
  }
}

/**
 * Idempotently (re)generates one thumbnail per subtitle for a project.
 * Skips work when the thumbs folder already has the right count and is
 * newer than `updatedAtMs` (a proxy for the subtitlesJson generation time).
 *
 * Sequential by design: 42 extractions take roughly 15-30s and running them
 * one at a time keeps ffmpeg CPU usage predictable during the pipeline.
 */
export async function generateBeatThumbs(
  projectId: string,
  videoPath: string,
  subtitles: SubtitleEntry[],
  updatedAtMs: number
): Promise<{ generated: boolean; count: number }> {
  const dir = beatThumbsDir(projectId)
  const expectedCount = subtitles.length

  if (expectedCount === 0) {
    return { generated: false, count: 0 }
  }

  if (await isUpToDate(dir, expectedCount, updatedAtMs)) {
    return { generated: false, count: expectedCount }
  }

  await mkdir(dir, { recursive: true })

  // Drop stale thumbs beyond the current subtitle count (e.g. a previous,
  // longer transcription) so listings don't show orphaned frames.
  try {
    const entries = await readdir(dir)
    for (const entry of entries) {
      const match = entry.match(/^beat_(\d+)\.jpg$/)
      if (match && Number(match[1]) >= expectedCount) {
        await unlink(path.join(dir, entry)).catch(() => {})
      }
    }
  } catch {
    // best-effort cleanup only
  }

  for (let index = 0; index < subtitles.length; index += 1) {
    const subtitle = subtitles[index]
    const atSeconds = subtitle.startTime + THUMB_OFFSET_SECONDS
    const outputPath = path.join(dir, beatThumbFileName(index))
    try {
      await extractThumbnail(videoPath, atSeconds, outputPath, THUMB_WIDTH)
    } catch (error) {
      console.warn(`generateBeatThumbs: failed to extract thumb ${index} for project ${projectId}:`, error)
    }
  }

  return { generated: true, count: expectedCount }
}
