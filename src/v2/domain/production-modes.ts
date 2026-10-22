import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

/**
 * The audio identity of an editorial timeline, frame first. (This module used to hold the talking-head planner of the first waves: a fixed
 * speaker-first template - a hook on the first beat, a call to action on the last, b-roll every third beat, no motion for 4 s. Nothing in the
 * product called it, and the rule of ADR-160 is that no template is fixed: what a video gets comes from its request. It was removed.)
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function identifier(value: string, field: string): string {
  const normalized = value.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

export function createEditorialAudioTimelineHash(input: { fps: number; clips: readonly Readonly<{ sourceArtifactId: string; audioSourceArtifactId?: string; audioSourceInFrame?: number; audioSourceOutFrame?: number; sourceInFrame: number; sourceOutFrame: number; timelineInFrame: number; timelineOutFrame: number; rate: number }>[] }): string {
  if (!Number.isFinite(input.fps) || input.fps <= 0 || input.clips.length < 1) throw new DomainError('INVALID_RENDER_INPUT', 'Audio timeline metadata is invalid')
  let cursor = 0
  const segments = input.clips.map((clip, index) => {
    const audioSourceInFrame = clip.audioSourceInFrame ?? clip.sourceInFrame
    const audioSourceOutFrame = clip.audioSourceOutFrame ?? clip.sourceOutFrame
    if (![audioSourceInFrame, audioSourceOutFrame, clip.timelineInFrame, clip.timelineOutFrame].every(Number.isSafeInteger) || clip.timelineInFrame !== cursor || clip.timelineOutFrame <= clip.timelineInFrame || audioSourceOutFrame <= audioSourceInFrame || !Number.isFinite(clip.rate) || clip.rate <= 0) throw new DomainError('INVALID_RENDER_INPUT', `Audio timeline segment ${index} is invalid`)
    cursor = clip.timelineOutFrame
    return Object.freeze({ artifactId: identifier(clip.audioSourceArtifactId ?? clip.sourceArtifactId, `clips[${index}].audioArtifactId`), audioSourceInFrame, audioSourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate })
  })
  return calculateCanonicalHash({ schemaVersion: 'editorial-audio-timeline/v1', fps: Number(input.fps.toFixed(6)), segments })
}
