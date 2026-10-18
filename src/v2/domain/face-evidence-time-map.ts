import { FACE_EVIDENCE_POLICY, faceSampleIntervalFrames, faceWindowFrames, maxSampleGapFrames } from './face-evidence-policy.ts'

/**
 * The time map a face window envelope is bound to, and the windows a caption plan needs (W65).
 *
 * `faceWindowTimeMap` is the non-throwing twin of the repository's `sourceMap`: the W62 producers only exist for a
 * timeline that is exactly ONE real-time clip of the source, and an envelope is bound to the canonical hash of that clip
 * map. A render that wants to read the evidence has to rebuild the same map from its own EditPlan; when the timeline is
 * anything else there is no evidence to read and the answer is `null` (the bands over the picture are then unknown).
 */
export type FaceWindowTimeMapEntry = Readonly<{
  clipId: string
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: 1
}>

export function faceWindowTimeMap(plan: unknown, sourceArtifactId: string): readonly FaceWindowTimeMapEntry[] | null {
  if (!plan || typeof plan !== 'object') return null
  const tracks = (plan as Record<string, unknown>).videoTracks
  if (!Array.isArray(tracks)) return null
  const clips = tracks.flatMap((track: unknown) => {
    const item = track as Record<string, unknown>
    return Array.isArray(item?.clips) ? item.clips : []
  })
  if (clips.length !== 1) return null
  const item = clips[0] as Record<string, unknown>
  if (item?.sourceArtifactId !== sourceArtifactId || typeof item.id !== 'string') return null
  const numbers = [item.sourceInFrame, item.sourceOutFrame, item.timelineInFrame, item.timelineOutFrame]
  if (!numbers.every((number) => Number.isSafeInteger(number) && Number(number) >= 0) ||
      Number(item.sourceOutFrame) <= Number(item.sourceInFrame) ||
      Number(item.sourceOutFrame) - Number(item.sourceInFrame) !== Number(item.timelineOutFrame) - Number(item.timelineInFrame) ||
      item.rate !== 1) return null
  return Object.freeze([Object.freeze({
    clipId: item.id, sourceInFrame: item.sourceInFrame as number, sourceOutFrame: item.sourceOutFrame as number,
    timelineInFrame: item.timelineInFrame as number, timelineOutFrame: item.timelineOutFrame as number, rate: 1 as const,
  })])
}

export type RequiredFaceWindow = Readonly<{ startTimelineFrame: number; endTimelineFrame: number }>

/**
 * The face windows (timeline frames, half-open, each at most `maxWindowFrames`) that would let the clearance of every
 * span answer: each span widened by the maximum sample gap on both sides, overlapping ones merged, then cut into
 * consecutive windows. It only LISTS them: requesting them is a separate act (W64 owns the automatic request).
 */
export function planRequiredFaceWindows(input: Readonly<{
  durationFrames: number
  fps: Readonly<{ num: number; den: number }>
  spans: readonly Readonly<{ startFrame: number; endFrame: number }>[]
}>): readonly RequiredFaceWindow[] {
  const gap = maxSampleGapFrames(input.fps)
  const windowFrames = faceWindowFrames(faceSampleIntervalFrames(input.fps))
  const widened = input.spans
    .filter((span) => Number.isSafeInteger(span.startFrame) && Number.isSafeInteger(span.endFrame) && span.endFrame > span.startFrame)
    .map((span) => ({ start: Math.max(0, span.startFrame - gap), end: Math.min(input.durationFrames, span.endFrame + gap) }))
    .filter((span) => span.end > span.start)
    .toSorted((left, right) => left.start - right.start || left.end - right.end)
  const merged: { start: number; end: number }[] = []
  for (const span of widened) {
    const last = merged.at(-1)
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  const windows: RequiredFaceWindow[] = []
  for (const span of merged) {
    for (let start = span.start; start < span.end; start += windowFrames) {
      windows.push(Object.freeze({ startTimelineFrame: start, endTimelineFrame: Math.min(span.end, start + windowFrames) }))
    }
  }
  return Object.freeze(windows)
}

/** The longest window one operation may cover at this rate (same arithmetic the producers use). */
export const FACE_WINDOW_MAX_FRAMES = FACE_EVIDENCE_POLICY.sampling.maxWindowFrames
