/**
 * Beat model: one beat = one subtitle/legenda. This is the canonical
 * per-caption unit used to map scenes onto the timeline for the editor UI
 * (thumbnails + scene coverage), independent of how scenes render.
 */

import type { SubtitleEntry } from './types/project'
import type { Scene } from './types/scene'

export interface BeatSceneSpan {
  from: number
  to: number
}

export interface Beat {
  index: number
  text: string
  startTime: number
  endTime: number
  startFrame: number
  endFrame: number
  sceneId: string | null
  sceneType: string | null
  sceneSpan: BeatSceneSpan | null
  isSpanStart: boolean
}

interface SceneRange {
  scene: Scene
  order: number
  startLeg: number
  endLeg: number
}

/**
 * Build the list of beats (one per subtitle) with the scene that owns each
 * beat resolved.
 *
 * Coverage rule: a scene covers beats [startLeg, startLeg + durationInSubtitles - 1]
 * (clamped to the subtitles range). When a beat is covered by more than one
 * scene, the scene that STARTS on that beat wins; otherwise the most
 * recently started covering scene (largest startLeg <= beat index) wins.
 */
export function buildBeats(subtitles: SubtitleEntry[], scenes: Scene[]): Beat[] {
  const lastIndex = subtitles.length - 1

  const ranges: SceneRange[] = scenes.map((scene, order) => {
    const startLeg = Math.max(0, Math.min(scene.startLeg, Math.max(0, lastIndex)))
    const duration = Math.max(1, scene.durationInSubtitles || 1)
    const endLeg = Math.max(startLeg, Math.min(Math.max(0, lastIndex), startLeg + duration - 1))
    return { scene, order, startLeg, endLeg }
  })

  return subtitles.map((subtitle, index) => {
    const covering = ranges.filter((r) => r.startLeg <= index && index <= r.endLeg)

    let chosen: SceneRange | null = null
    if (covering.length > 0) {
      const starter = covering.find((r) => r.startLeg === index)
      if (starter) {
        chosen = starter
      } else {
        chosen = covering.reduce((best, current) => {
          if (current.startLeg > best.startLeg) return current
          if (current.startLeg === best.startLeg && current.order > best.order) return current
          return best
        })
      }
    }

    return {
      index,
      text: subtitle.text,
      startTime: subtitle.startTime,
      endTime: subtitle.endTime,
      startFrame: subtitle.startFrame,
      endFrame: subtitle.endFrame,
      sceneId: chosen ? chosen.scene.id : null,
      sceneType: chosen ? chosen.scene.type : null,
      sceneSpan: chosen ? { from: chosen.startLeg, to: chosen.endLeg } : null,
      isSpanStart: chosen ? chosen.startLeg === index : false
    }
  })
}
