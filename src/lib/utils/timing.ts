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

export function secondsToFrames(seconds: number, fps: number = FPS): number {
  return Math.max(0, Math.round(seconds * fps))
}

export function framesToSeconds(frames: number, fps: number = FPS): number {
  return Math.max(0, frames) / fps
}

function getSceneTextForReading(scene: Scene): string {
  const data = scene as any
  const values = [
    data.text,
    data.title,
    data.subtitle,
    data.description,
    data.message,
    data.value,
    data.label,
    data.topText,
    data.bottomText,
    data.leftText,
    data.rightText,
    data.situation,
    data.caption,
    ...(Array.isArray(data.steps) ? data.steps : [])
  ]

  return values
    .filter(Boolean)
    .join(' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function getSceneTypeScore(type: Scene['type']): number {
  const scores: Record<string, number> = {
    FullScreen: 9,
    LowerThird: 7,
    Split: 8,
    SplitVertical: 10,
    Card: 9,
    Message: 6,
    Number: 7,
    Flow: 8,
    CTA: 10,
    StickFigures: 7,
    ImageInsert: 8
  }

  return scores[type] || 5
}

export function curateSceneDensity(scenes: Scene[], targetRatio = 0.6): Scene[] {
  if (scenes.length <= 10) {
    return scenes
  }

  const targetCount = Math.max(5, Math.min(scenes.length, Math.round(scenes.length * targetRatio)))
  const selected = new Map<number, Scene>()

  selected.set(0, scenes[0])

  const ctaIndex = scenes.findLastIndex((scene) => scene.type === 'CTA')
  const lastIndex = ctaIndex >= 0 ? ctaIndex : scenes.length - 1
  selected.set(lastIndex, scenes[lastIndex])

  const candidates = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ index }) => !selected.has(index))

  const slots = Math.max(0, targetCount - selected.size)

  for (let slot = 0; slot < slots; slot += 1) {
    const start = Math.floor((slot * candidates.length) / slots)
    const end = Math.max(start + 1, Math.floor(((slot + 1) * candidates.length) / slots))
    const bucket = candidates.slice(start, end).filter(({ index }) => !selected.has(index))

    if (bucket.length === 0) {
      continue
    }

    const best = bucket
      .map((candidate) => ({
        ...candidate,
        score:
          getSceneTypeScore(candidate.scene.type) +
          Math.min(4, getSceneTextForReading(candidate.scene).length / 42)
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]

    selected.set(best.index, best.scene)
  }

  return [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, scene]) => scene)
}

function estimateSceneReadFrames(scene: Scene, fps: number): number {
  if (scene.type === 'ImageInsert') {
    const layout = (scene as any).layout
    return Math.round((layout === 'split-bottom' ? 4.8 : layout === 'top-image-compact' ? 4.6 : 4.2) * fps)
  }

  const text = getSceneTextForReading(scene)
  const readSeconds = Math.min(5.6, Math.max(2.8, 1.35 + text.length / 24))
  return Math.round(readSeconds * fps)
}

/**
 * Resolve scene timing by computing startFrame and endFrame for all scenes
 * @param scenes Array of scenes with startLeg and durationInSubtitles
 * @param subtitles Array of subtitle entries
 * @returns Scenes with startFrame and endFrame populated
 */
export function resolveSceneTiming(
  scenes: Scene[],
  subtitles: SubtitleEntry[],
  fps: number = FPS
): Scene[] {
  if (subtitles.length === 0) {
    return scenes.map(scene => ({
      ...scene,
      startFrame: 0,
      endFrame: fps
    }))
  }

  const minDurationFrames = Math.max(1, Math.round(fps * 2.8))
  const maxDurationFrames = Math.max(minDurationFrames, Math.round(fps * 5.6))
  const gapFrames = Math.max(6, Math.round(fps * 0.35))
  const timelineEndFrame = Math.max(...subtitles.map((subtitle) => subtitle.endFrame))

  const timedScenes = scenes
    .map((scene, index) => {
      const startLeg = Math.max(0, Math.min(scene.startLeg, subtitles.length - 1))
      const durationInSubtitles = Math.max(1, Math.min(scene.durationInSubtitles || 1, 3))
      const endLeg = Math.max(
        startLeg,
        Math.min(subtitles.length - 1, startLeg + durationInSubtitles - 1)
      )
      const startFrame = convertStartLegToFrame(startLeg, subtitles)
      const subtitleEndFrame = subtitles[endLeg]?.endFrame || startFrame + minDurationFrames
      const readEndFrame = startFrame + estimateSceneReadFrames(scene, fps)
      const rawEndFrame = Math.min(
        Math.max(subtitleEndFrame, readEndFrame, startFrame + minDurationFrames),
        startFrame + maxDurationFrames
      )

      return {
        scene,
        index,
        startLeg,
        durationInSubtitles,
        initialStartFrame: startFrame,
        rawEndFrame
      }
    })
    .sort((a, b) => a.initialStartFrame - b.initialStartFrame || a.index - b.index)

  let cursorFrame = 0

  return timedScenes.map((entry, index) => {
    const startFrame = Math.max(entry.initialStartFrame, cursorFrame)
    const rawDurationFrames = Math.max(
      entry.rawEndFrame - entry.initialStartFrame,
      minDurationFrames
    )
    const endLimit = Math.max(startFrame + minDurationFrames, timelineEndFrame + Math.round(fps * 0.25))
    const endFrame = Math.min(
      Math.max(startFrame + rawDurationFrames, startFrame + minDurationFrames),
      endLimit
    )
    cursorFrame = endFrame + gapFrames

    return {
      ...entry.scene,
      startLeg: entry.startLeg,
      durationInSubtitles: entry.durationInSubtitles,
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
