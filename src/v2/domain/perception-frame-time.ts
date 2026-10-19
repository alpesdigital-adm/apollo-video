import { DomainError } from './errors.ts'
import { mergeRanges, type PerceptionRange } from './perception-timeline.ts'

/**
 * The one place that turns the frames of an EditPlan into the milliseconds of a perception timeline (W63a).
 *
 * The canonical clock of a timeline is the EditPlan's: `ms = round(frame / fps * 1000)`, and the timeline is
 * `ceil(durationFrames / fps * 1000)` long. Nothing is interpolated: a frame range is mapped end to end, and two ranges that
 * touch in frames touch in milliseconds, so a kind whose frames are ALL examined covers the whole duration (and only then).
 */
export type FrameRange = Readonly<{ startFrame: number; endFrame: number }>

export function perceptionDurationMs(durationFrames: number, fps: number): number {
  if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new DomainError('INVALID_ARGUMENT', 'Perception clock needs a positive frame count and frame rate')
  }
  return Math.max(1, Math.ceil(durationFrames / fps * 1000))
}

/** The millisecond range of the half-open frame range [startFrame, endFrame). The tail frame ends exactly at the duration. */
export function frameSpanToMs(span: FrameRange, fps: number, durationFrames: number, durationMs: number): PerceptionRange {
  const startMs = Math.min(durationMs - 1, Math.round(span.startFrame / fps * 1000))
  const endMs = span.endFrame >= durationFrames
    ? durationMs
    : Math.min(durationMs, Math.max(startMs + 1, Math.round(span.endFrame / fps * 1000)))
  return Object.freeze([startMs, endMs]) as PerceptionRange
}

/** Frame ranges, merged in the FRAME domain (touching or overlapping ones join), then mapped to milliseconds. */
export function mergedFrameRanges(ranges: readonly FrameRange[]): readonly FrameRange[] {
  const merged: { startFrame: number; endFrame: number }[] = []
  for (const current of [...ranges].sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame)) {
    const previous = merged.at(-1)
    if (previous && current.startFrame <= previous.endFrame) previous.endFrame = Math.max(previous.endFrame, current.endFrame)
    else merged.push({ startFrame: current.startFrame, endFrame: current.endFrame })
  }
  return Object.freeze(merged.map((range) => Object.freeze(range)))
}

export function frameRangesToCoverageMs(
  ranges: readonly FrameRange[], fps: number, durationFrames: number, durationMs: number,
): readonly PerceptionRange[] {
  const frames = mergedFrameRanges(ranges.filter((range) =>
    Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) &&
    range.startFrame >= 0 && range.endFrame > range.startFrame && range.startFrame < durationFrames))
  return mergeRanges(frames.map((range) => frameSpanToMs(
    { startFrame: range.startFrame, endFrame: Math.min(range.endFrame, durationFrames) }, fps, durationFrames, durationMs)))
}
