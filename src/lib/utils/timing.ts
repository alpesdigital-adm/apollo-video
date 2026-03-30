/**
 * Timing utilities for converting between subtitle indices and frame numbers
 */

import type { SubtitleEntry, Silence } from '../types/project'
import type { Scene } from '../types/scene'
import { FPS } from '../types/timing'

/**
 * Convert a startLeg subtitle index to a frame number
 * @param startLeg The subtitle index (0-based)
 * @param subtitles Array of subtitle entries
 * @returns Frame number, or 0 if index is out of bounds
 */
export function convertStartLegToFrame(startLeg: number, subtitles: SubtitleEntry[]): number {
  if (startLeg < 0 || startLeg >= subtitles.length) {
    return 0
  }
  return subtitles[startLeg].startFrame
}

/**
 * Resolve scene timing by computing startFrame and endFrame for all scenes
 * @param scenes Array of scenes with startLeg and durationInSubtitles
 * @param subtitles Array of subtitle entries
 * @returns Scenes with startFrame and endFrame populated
 */
export function resolveSceneTiming(scenes: Scene[], subtitles: SubtitleEntry[]): Scene[] {
  if (subtitles.length === 0) {
    return scenes.map(scene => ({
      ...scene,
      startFrame: 0,
      endFrame: 0
    }))
  }

  // Calculate average subtitle duration in frames
  let totalDuration = 0
  for (const subtitle of subtitles) {
    totalDuration += subtitle.endFrame - subtitle.startFrame
  }
  const avgSubtitleDuration = subtitles.length > 0 ? totalDuration / subtitles.length : FPS

  return scenes.map(scene => {
    const startFrame = convertStartLegToFrame(scene.startLeg, subtitles)
    const endFrame = startFrame + Math.round(scene.durationInSubtitles * avgSubtitleDuration)

    return {
      ...scene,
      startFrame,
      endFrame
    }
  })
}

/**
 * Recalculate subtitle timings after silence cuts
 * Shifts all subsequent subtitles backwards based on removed silence duration
 * @param subtitles Array of subtitle entries
 * @param silences Array of silence objects that were cut
 * @returns Updated subtitles with adjusted timing
 */
export function recalculateTimingsAfterSilenceCut(
  subtitles: SubtitleEntry[],
  silences: Silence[]
): SubtitleEntry[] {
  if (silences.length === 0) {
    return subtitles
  }

  // Sort silences by start time
  const sortedSilences = [...silences].sort((a, b) => a.startTime - b.startTime)

  return subtitles.map(subtitle => {
    let timeShift = 0

    // Calculate total time removed before this subtitle
    for (const silence of sortedSilences) {
      if (silence.endTime <= subtitle.startTime) {
        // This silence is completely before the subtitle
        timeShift += silence.duration
      } else if (silence.startTime < subtitle.startTime && silence.endTime > subtitle.startTime) {
        // This silence partially overlaps the subtitle's start
        timeShift += silence.endTime - subtitle.startTime
        break
      }
    }

    // Calculate frame shift (assuming FPS constant)
    const frameShift = Math.round(timeShift * FPS)

    return {
      ...subtitle,
      startTime: Math.max(0, subtitle.startTime - timeShift),
      endTime: Math.max(0, subtitle.endTime - timeShift),
      startFrame: Math.max(0, subtitle.startFrame - frameShift),
      endFrame: Math.max(0, subtitle.endFrame - frameShift)
    }
  })
}
