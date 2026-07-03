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

/**
 * Absolute floor for a scene's duration (seconds). This is the only hard
 * minimum enforced when trimming — and only applies when it does not
 * invade the next scene's (sacred) startFrame.
 */
export const MIN_SCENE_SECONDS = 1.2

function estimateSceneReadFrames(scene: Scene, fps: number): number {
  if (scene.type === 'ImageInsert') {
    const layout = (scene as any).layout
    return Math.round((layout === 'split-bottom' ? 4.8 : layout === 'top-image-compact' ? 4.6 : 4.2) * fps)
  }

  const text = getSceneTextForReading(scene)
  // Piso de legibilidade 2.0s / teto 7.0s para cenas de texto (timing dirigido pela fala)
  const readSeconds = Math.min(7.0, Math.max(2.0, 1.35 + text.length / 24))
  return Math.round(readSeconds * fps)
}

/**
 * Resolve scene timing by computing startFrame and endFrame for all scenes.
 *
 * Regra de timing (dirigido pela fala):
 *  - O fim alvo de cada cena é o fim da última legenda coberta
 *    (startLeg + durationInSubtitles - 1) + margem de ~0.4s, respeitando um
 *    piso de legibilidade (estimateSceneReadFrames) e um teto de 7.0s.
 *  - Starts são sagrados: NUNCA são deslocados para resolver colisão.
 *  - Se a cena N+1 começa antes do fim desejado da cena N, o fim da cena N é
 *    TRIMADO até o startFrame da N+1 (sem gap obrigatório): endFrame(N) =
 *    min(endFrame_desejado(N), startFrame(N+1)).
 *  - Um piso absoluto de MIN_SCENE_SECONDS (1.2s) é aplicado por cima do trim,
 *    mas só até onde não invadir o start da próxima cena:
 *    endFrame(N) = max(endFrame_trimado, min(startFrame(N) + MIN_SCENE_SECONDS, startFrame(N+1))).
 *
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

  const minSceneFrames = Math.max(1, Math.round(fps * MIN_SCENE_SECONDS))
  const ceilingFrames = Math.round(fps * 7.0)
  const marginFrames = Math.round(fps * 0.4)
  const timelineEndFrame = Math.max(...subtitles.map((subtitle) => subtitle.endFrame))

  const timedScenes = scenes
    .map((scene, index) => {
      const startLeg = Math.max(0, Math.min(scene.startLeg, subtitles.length - 1))
      const durationInSubtitles = Math.max(1, Math.min(scene.durationInSubtitles || 1, 4))
      const endLeg = Math.max(
        startLeg,
        Math.min(subtitles.length - 1, startLeg + durationInSubtitles - 1)
      )
      const startFrame = convertStartLegToFrame(startLeg, subtitles)
      const subtitleEndFrame = subtitles[endLeg]?.endFrame ?? startFrame
      const speechEndFrame = subtitleEndFrame + marginFrames
      const readEndFrame = startFrame + estimateSceneReadFrames(scene, fps)
      const desiredEndFrame = Math.min(
        Math.max(speechEndFrame, readEndFrame),
        startFrame + ceilingFrames
      )

      return {
        scene,
        index,
        startLeg,
        durationInSubtitles,
        startFrame,
        desiredEndFrame
      }
    })
    .sort((a, b) => a.startFrame - b.startFrame || a.index - b.index)

  return timedScenes.map((entry, index) => {
    const next = timedScenes[index + 1]
    const nextStartFrame = next
      ? next.startFrame
      : Math.max(timelineEndFrame + marginFrames, entry.startFrame + minSceneFrames)

    const trimmedEndFrame = Math.min(entry.desiredEndFrame, nextStartFrame)
    const softFloorEndFrame = Math.min(entry.startFrame + minSceneFrames, nextStartFrame)
    const endFrame = Math.max(trimmedEndFrame, softFloorEndFrame)

    return {
      ...entry.scene,
      startLeg: entry.startLeg,
      durationInSubtitles: entry.durationInSubtitles,
      startFrame: entry.startFrame,
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
