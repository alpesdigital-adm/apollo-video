import { assertDomain } from './errors.ts'
import { canvasBandSourceAreas, type CaptionProjection } from './caption-canvas-projection.ts'
import { evaluateFaceCaptionClearance, type CaptionAreaRange, type FaceClearanceState } from './face-caption-clearance.ts'
import type { FaceEvidenceStream } from './face-evidence-stream.ts'
import type { NormalizedBounds } from './output-spec.ts'

/**
 * Face clearance of one caption BAND of the variant canvas (W65).
 *
 * `evaluateFaceCaptionClearance` answers for an area given in the normalized space of the SOURCE frame. A band lives on
 * the canvas, so it is first mapped back through the render's single projection (`canvasBandSourceAreas`), clip by clip
 * and keyframe segment by keyframe segment, and every span is judged on its own evidence:
 *
 * - the band touches no pixel of the clip's picture (it sits over the blurred copy or over staging bars): no face of
 *   that source can be under it - `geometry-outside-foreground`, certified without detector evidence;
 * - the band overlaps the picture: the trusted face evidence of THAT clip's source decides (`face-clearance`), through
 *   the W62 three-state clearance, over the spans that tile the overlap;
 * - the source has no evidence stream, or the span has no clip: `unknown`.
 *
 * The result is the conservative combination: any span `occupied` makes the band `occupied`; otherwise any `unknown`
 * makes it `unknown`; only a window whose every span is certified is `free-certified`. `free-certified` keeps the W62
 * meaning - no trusted detection overlaps in the sampled evidence - and is never a statement that no face is present.
 */
export const BAND_EVALUATION_KINDS = Object.freeze([
  'geometry-outside-foreground', 'face-clearance', 'no-face-evidence', 'timeline-not-covered', 'projection-unavailable',
] as const)
export type BandEvaluationKind = (typeof BAND_EVALUATION_KINDS)[number]

export type BandEvaluationV1 = Readonly<{
  kind: BandEvaluationKind
  sourceArtifactId: string | null
  startFrame: number
  endFrame: number
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

export type FaceEvidenceForSource = Readonly<{ sourceArtifactId: string; stream: FaceEvidenceStream }>

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
      state: 'unknown' as const, clearanceHash: null, reasons: Object.freeze([reason]),
    })]),
  })
}

export function evaluateBandFaceClearance(input: Readonly<{
  projection: Readonly<CaptionProjection>
  evidence: readonly FaceEvidenceForSource[]
  band: Readonly<NormalizedBounds>
  window: Readonly<{ startFrame: number; endFrame: number }>
}>): BandFaceClearanceV1 {
  const streams = new Map(input.evidence.map((entry) => [entry.sourceArtifactId, entry.stream]))
  assertDomain(streams.size === input.evidence.length, 'INVALID_ARGUMENT', 'Face evidence must be unique per source')
  const segments = canvasBandSourceAreas(input.projection, input.band, input.window)
  const evaluations: BandEvaluationV1[] = []
  let index = 0
  while (index < segments.length) {
    const segment = segments[index]!
    if (segment.kind === 'uncovered') {
      evaluations.push(Object.freeze({
        kind: 'timeline-not-covered' as const, sourceArtifactId: null, startFrame: segment.startFrame, endFrame: segment.endFrame,
        state: 'unknown' as const, clearanceHash: null, reasons: Object.freeze(['TIMELINE_NOT_COVERED_BY_A_CLIP']),
      }))
      index += 1
      continue
    }
    if (segment.kind === 'outside-foreground') {
      evaluations.push(Object.freeze({
        kind: 'geometry-outside-foreground' as const, sourceArtifactId: segment.sourceArtifactId, startFrame: segment.startFrame, endFrame: segment.endFrame,
        state: 'free-certified' as const, clearanceHash: null, reasons: Object.freeze(['GEOMETRY_NO_FOREGROUND_OVERLAP']),
      }))
      index += 1
      continue
    }
    // A run of adjacent spans over the picture of the same source is judged together: the W62 clearance wants one cue
    // span and an area that tiles it.
    let end = index
    while (end + 1 < segments.length && segments[end + 1]!.kind === 'source' &&
      segments[end + 1]!.sourceArtifactId === segment.sourceArtifactId && segments[end + 1]!.startFrame === segments[end]!.endFrame) end += 1
    const run = segments.slice(index, end + 1)
    const startFrame = run[0]!.startFrame, endFrame = run.at(-1)!.endFrame
    const stream = streams.get(segment.sourceArtifactId!)
    if (!stream) {
      evaluations.push(Object.freeze({
        kind: 'no-face-evidence' as const, sourceArtifactId: segment.sourceArtifactId, startFrame, endFrame,
        state: 'unknown' as const, clearanceHash: null, reasons: Object.freeze(['NO_FACE_EVIDENCE_FOR_SOURCE']),
      }))
    } else if (endFrame > stream.timelineDurationFrames) {
      evaluations.push(Object.freeze({
        kind: 'face-clearance' as const, sourceArtifactId: segment.sourceArtifactId, startFrame, endFrame,
        state: 'unknown' as const, clearanceHash: null, reasons: Object.freeze(['SPAN_OUTSIDE_EVIDENCE_TIMELINE']),
      }))
    } else {
      const area: CaptionAreaRange[] = run.map((part) => Object.freeze({ startFrame: part.startFrame, endFrame: part.endFrame, bounds: part.area! }))
      const clearance = evaluateFaceCaptionClearance({ stream, cue: { startFrame, endFrame }, area })
      evaluations.push(Object.freeze({
        kind: 'face-clearance' as const, sourceArtifactId: segment.sourceArtifactId, startFrame, endFrame,
        state: clearance.state, clearanceHash: clearance.clearanceHash, reasons: clearance.reasons,
      }))
    }
    index = end + 1
  }
  const reasons = [...new Set(evaluations.flatMap((evaluation) => evaluation.reasons))].toSorted()
  return Object.freeze({
    state: combineClearanceStates(evaluations.map((evaluation) => evaluation.state)),
    reasons: Object.freeze(reasons), evaluations: Object.freeze(evaluations),
  })
}
