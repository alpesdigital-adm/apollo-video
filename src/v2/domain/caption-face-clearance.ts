import { assertDomain } from './errors.ts'
import { canvasBandSourceAreas, type BandSourceSegment, type CaptionProjection, type ProjectionClip } from './caption-canvas-projection.ts'
import { evaluateFaceCaptionClearance, type CaptionAreaRange, type FaceClearanceState } from './face-caption-clearance.ts'
import { sourceStreamForClearance, type FaceSourceEvidenceStream } from './face-source-evidence-stream.ts'
import type { NormalizedBounds } from './output-spec.ts'

/**
 * Face clearance of one caption BAND of the variant canvas (W65, source-keyed since W65b).
 *
 * `evaluateFaceCaptionClearance` answers for an area given in the normalized space of the SOURCE frame, over a range of frames of
 * the stream it is given. A band lives on the canvas and a cue lives on the timeline, so the band is first mapped back through the
 * render's single projection (`canvasBandSourceAreas`), clip by clip and keyframe segment by keyframe segment, and every span is
 * judged on its own evidence - in the frames of the SOURCE the clip plays, because that is where the evidence is keyed:
 *
 * - the band touches no pixel of the clip's picture (it sits over the blurred copy or over staging bars): no face of that source
 *   can be under it - `geometry-outside-foreground`, certified without detector evidence;
 * - the band overlaps the picture: the trusted face evidence of THAT clip's source decides (`face-clearance`). The span of
 *   timeline frames is translated through the clip into a range of source frames (`sourceFrame = timelineFrame + sourceIn -
 *   timelineIn`; only a unit-rate clip with equal-length ranges has such a pure offset) and the W62 three-state clearance runs on
 *   the source stream over that range. Spans of different clips are never merged, even adjacent ones of the same source: a cut is
 *   a jump in the source's time. Samples of the source just outside the clip's own range still vouch for its edges, because the
 *   source is continuous and immutable;
 * - a clip whose mapping cannot be proven (a rate other than 1, or ranges of different length) is `unknown`: `clip-map-unprovable`;
 * - the source has no evidence stream, or the span has no clip: `unknown`.
 *
 * The result is the conservative combination: any span `occupied` makes the band `occupied`; otherwise any `unknown` makes it
 * `unknown`; only a window whose every span is certified is `free-certified`. `free-certified` keeps the W62 meaning - no trusted
 * detection overlaps in the sampled evidence - and is never a statement that no face is present.
 */
export const BAND_EVALUATION_KINDS = Object.freeze([
  'geometry-outside-foreground', 'face-clearance', 'no-face-evidence', 'timeline-not-covered', 'projection-unavailable', 'clip-map-unprovable',
] as const)
export type BandEvaluationKind = (typeof BAND_EVALUATION_KINDS)[number]

export type BandEvaluationV1 = Readonly<{
  kind: BandEvaluationKind
  sourceArtifactId: string | null
  /** Half-open range of TIMELINE frames this evaluation covers (the plan's frame domain). */
  startFrame: number
  endFrame: number
  /** The half-open range of SOURCE frames that was judged, for `face-clearance`; `null` for the other kinds. */
  sourceRange: Readonly<{ startFrame: number; endFrame: number }> | null
  state: FaceClearanceState
  /** `clearanceHash` of the W62 evaluation when `kind` is `face-clearance`. */
  clearanceHash: string | null
  reasons: readonly string[]
}>

export type BandFaceClearanceV1 = Readonly<{
  state: FaceClearanceState
  reasons: readonly string[]
  evaluations: readonly BandEvaluationV1[]
}>

/** The evidence of one source, in source frames; `stream: null` says why none could be used (never silently absent). */
export type FaceEvidenceForSource = Readonly<
  | { sourceArtifactId: string; stream: FaceSourceEvidenceStream }
  | { sourceArtifactId: string; stream: null; unavailableReason: string }
>

/** The conservative combination of the states of consecutive spans. */
export function combineClearanceStates(states: readonly FaceClearanceState[]): FaceClearanceState {
  if (states.includes('occupied')) return 'occupied'
  if (states.length === 0 || states.includes('unknown')) return 'unknown'
  return 'free-certified'
}

/** Band whose projection could not be established: every span is unknown, and says why. */
export function unprojectableBandClearance(window: Readonly<{ startFrame: number; endFrame: number }>, reason: string): BandFaceClearanceV1 {
  return Object.freeze({
    state: 'unknown' as const,
    reasons: Object.freeze([reason]),
    evaluations: Object.freeze([Object.freeze({
      kind: 'projection-unavailable' as const, sourceArtifactId: null, startFrame: window.startFrame, endFrame: window.endFrame,
      sourceRange: null, state: 'unknown' as const, clearanceHash: null, reasons: Object.freeze([reason]),
    })]),
  })
}

const unknownEvaluation = (
  kind: BandEvaluationKind, sourceArtifactId: string | null, startFrame: number, endFrame: number, reason: string,
): BandEvaluationV1 => Object.freeze({
  kind, sourceArtifactId, startFrame, endFrame, sourceRange: null, state: 'unknown' as const, clearanceHash: null, reasons: Object.freeze([reason]),
})

/** The frame offset of a clip (source minus timeline), or why there is none. */
function clipOffset(clip: Readonly<ProjectionClip>): Readonly<{ offset: number }> | Readonly<{ reason: 'CLIP_RATE_NOT_UNIT' | 'CLIP_MAP_INCONSISTENT' }> {
  if (clip.rate !== 1) return { reason: 'CLIP_RATE_NOT_UNIT' }
  if (clip.sourceOutFrame - clip.sourceInFrame !== clip.timelineOutFrame - clip.timelineInFrame) return { reason: 'CLIP_MAP_INCONSISTENT' }
  return { offset: clip.sourceInFrame - clip.timelineInFrame }
}

export function evaluateBandFaceClearance(input: Readonly<{
  projection: Readonly<CaptionProjection>
  evidence: readonly FaceEvidenceForSource[]
  band: Readonly<NormalizedBounds>
  window: Readonly<{ startFrame: number; endFrame: number }>
}>): BandFaceClearanceV1 {
  const streams = new Map(input.evidence.map((entry) => [entry.sourceArtifactId, entry]))
  assertDomain(streams.size === input.evidence.length, 'INVALID_ARGUMENT', 'Face evidence must be unique per source')
  const segments = canvasBandSourceAreas(input.projection, input.band, input.window)
  const clips = new Map(input.projection.clips.map((clip) => [clip.id, clip]))
  const evaluations: BandEvaluationV1[] = []
  let index = 0
  while (index < segments.length) {
    const segment = segments[index]!
    if (segment.kind === 'uncovered') {
      evaluations.push(unknownEvaluation('timeline-not-covered', null, segment.startFrame, segment.endFrame, 'TIMELINE_NOT_COVERED_BY_A_CLIP'))
      index += 1
      continue
    }
    if (segment.kind === 'outside-foreground') {
      evaluations.push(Object.freeze({
        kind: 'geometry-outside-foreground' as const, sourceArtifactId: segment.sourceArtifactId, startFrame: segment.startFrame, endFrame: segment.endFrame,
        sourceRange: null, state: 'free-certified' as const, clearanceHash: null, reasons: Object.freeze(['GEOMETRY_NO_FOREGROUND_OVERLAP']),
      }))
      index += 1
      continue
    }
    // A run of adjacent spans over the picture of the SAME CLIP (a reframe cuts one clip into linear spans) is judged together:
    // the W62 clearance wants one cue span and an area that tiles it. Spans of different clips are never one run.
    let end = index
    while (end + 1 < segments.length && segments[end + 1]!.kind === 'source' &&
      segments[end + 1]!.clipId === segment.clipId && segments[end + 1]!.startFrame === segments[end]!.endFrame) end += 1
    const run: readonly BandSourceSegment[] = segments.slice(index, end + 1)
    const startFrame = run[0]!.startFrame, endFrame = run.at(-1)!.endFrame
    const sourceArtifactId = segment.sourceArtifactId!
    const evidence = streams.get(sourceArtifactId)
    const clip = clips.get(segment.clipId!)!
    const mapping = clipOffset(clip)
    if ('reason' in mapping) {
      // Whatever evidence exists, the frames of this clip cannot be pinned to frames of the source.
      evaluations.push(unknownEvaluation('clip-map-unprovable', sourceArtifactId, startFrame, endFrame, mapping.reason))
    } else if (!evidence) {
      evaluations.push(unknownEvaluation('no-face-evidence', sourceArtifactId, startFrame, endFrame, 'NO_FACE_EVIDENCE_FOR_SOURCE'))
    } else if (evidence.stream === null) {
      evaluations.push(unknownEvaluation('no-face-evidence', sourceArtifactId, startFrame, endFrame, evidence.unavailableReason))
    } else {
      const sourceStart = startFrame + mapping.offset, sourceEnd = endFrame + mapping.offset
      const sourceRange = Object.freeze({ startFrame: sourceStart, endFrame: sourceEnd })
      if (sourceStart < 0 || sourceEnd > evidence.stream.sourceDurationFrames) {
        evaluations.push(Object.freeze({
          kind: 'face-clearance' as const, sourceArtifactId, startFrame, endFrame, sourceRange,
          state: 'unknown' as const, clearanceHash: null, reasons: Object.freeze(['SPAN_OUTSIDE_EVIDENCE_TIMELINE']),
        }))
      } else {
        const area: CaptionAreaRange[] = run.map((part) => Object.freeze({
          startFrame: part.startFrame + mapping.offset, endFrame: part.endFrame + mapping.offset, bounds: part.area!,
        }))
        const clearance = evaluateFaceCaptionClearance({ stream: sourceStreamForClearance(evidence.stream), cue: sourceRange, area })
        evaluations.push(Object.freeze({
          kind: 'face-clearance' as const, sourceArtifactId, startFrame, endFrame, sourceRange,
          state: clearance.state, clearanceHash: clearance.clearanceHash, reasons: clearance.reasons,
        }))
      }
    }
    index = end + 1
  }
  const reasons = [...new Set(evaluations.flatMap((evaluation) => evaluation.reasons))].toSorted()
  return Object.freeze({
    state: combineClearanceStates(evaluations.map((evaluation) => evaluation.state)),
    reasons: Object.freeze(reasons), evaluations: Object.freeze(evaluations),
  })
}
