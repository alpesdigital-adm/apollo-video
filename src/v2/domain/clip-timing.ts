import { DomainError } from './errors.ts'

/**
 * Canonical clip retiming invariants.
 *
 * The renderer and the source transcript replacement must agree bit for bit on
 * what a clip rate means, otherwise materialized evidence would describe frames
 * the renderer refuses to produce. This module is the single owner of that
 * arithmetic; infrastructure imports from here and never the other way round.
 */

export const MIN_CLIP_RATE = 0.25
export const MAX_CLIP_RATE = 4

/**
 * Predicate form of the supported rate window. Callers that need their own
 * error code/message (the domain command path uses `INVALID_ARGUMENT`, not the
 * renderer's `INVALID_RENDER_INPUT`) validate through this so both paths share
 * exactly one definition of "supported rate".
 */
export function isSupportedClipRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0 && rate >= MIN_CLIP_RATE && rate <= MAX_CLIP_RATE
}

export function assertClipRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Editorial clip rate must be a finite number')
  }
  if (rate <= 0) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      'Editorial clip rate must be greater than zero: reverse playback is not supported',
    )
  }
  if (rate < MIN_CLIP_RATE || rate > MAX_CLIP_RATE) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      `Editorial clip rate ${rate} is outside the supported range [${MIN_CLIP_RATE}, ${MAX_CLIP_RATE}]`,
    )
  }
  return rate
}

/**
 * Frame-first timing: the timeline span is the truth and the source span is read
 * through the rate. A clip covering `s` source frames at `rate` must occupy
 * exactly `round(s / rate)` timeline frames, so no clip can drift against its
 * neighbours once concatenated.
 */
export function timelineSpanForRate(sourceSpan: number, rate: number): number {
  return Math.round(sourceSpan / rate)
}

/**
 * Projects a source frame onto the timeline of the clip that carries it.
 *
 * The offset is measured inside the clip's own source span and divided by the
 * rate with the same `Math.round` the renderer applies, then clamped to the
 * clip so retimed evidence can never point outside the segment it came from.
 * At `rate === 1` this reduces to `timelineIn + (frame - sourceIn)`, which is
 * the pre-rate arithmetic byte for byte.
 */
export function sourceFrameToTimelineFrame(
  sourceFrame: number,
  range: Readonly<{
    sourceInFrame: number
    timelineInFrame: number
    timelineOutFrame: number
    rate: number
  }>,
): number {
  const projected = range.timelineInFrame + Math.round((sourceFrame - range.sourceInFrame) / range.rate)
  if (projected < range.timelineInFrame) return range.timelineInFrame
  if (projected > range.timelineOutFrame) return range.timelineOutFrame
  return projected
}
