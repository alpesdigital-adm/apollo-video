import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import type { NormalizedBounds } from './output-spec.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, maxSampleGapFrames } from './face-evidence-policy.ts'
import type { FaceEvidenceSample, FaceEvidenceStream } from './face-evidence-stream.ts'

/**
 * Is the caption area free of faces during a cue? Three states, and the default is the safe one.
 *
 * - `occupied`: some trusted detection (score >= the clearance floor, any size, any position), dilated by the
 *   policy margin, overlaps the area during the cue. Closed rectangles: touching counts.
 * - `free-certified`: every trusted sample that vouches for the cue's frames was analysed, consecutive samples are no
 *   further apart than the policy gap, samples exist before and after the cue, no evidence that could not be trusted
 *   lies near the cue, and no dilated detection overlaps the area. It certifies the owner-accepted detector scope
 *   against sampled evidence. It never says there is no face, and it never grants `faceSafety`.
 * - `unknown`: anything else, including no evidence at all.
 *
 * Precedence: untrusted evidence near the cue makes the answer `unknown` (the overlap itself cannot be trusted);
 * otherwise an overlap among trusted samples is `occupied` even when other samples are missing; otherwise
 * incomplete coverage is `unknown`; only a complete, overlap-free span is `free-certified`.
 *
 * The area is given in the same normalized source-frame space as the detections, as time ranges (a reframe
 * trajectory may move it). The caller maps output bands into that space; this function never guesses it.
 */
export type CaptionAreaRange = Readonly<{ startFrame: number; endFrame: number; bounds: Readonly<NormalizedBounds> }>
export type FaceClearanceState = 'free-certified' | 'occupied' | 'unknown'
export type FaceClearanceOccupant = Readonly<{
  timelineFrame: number; confidence: number
  boxXYXY: readonly [number, number, number, number]
  dilatedXYXY: readonly [number, number, number, number]
}>
export type FaceCaptionClearance = Readonly<{
  schemaVersion: 'face-caption-clearance/v1'
  policySha256: string
  streamHash: string
  cue: Readonly<{ startFrame: number; endFrame: number }>
  state: FaceClearanceState
  reasons: readonly string[]
  coverage: Readonly<{
    samplesConsidered: number
    firstSampleFrame: number | null; lastSampleFrame: number | null
    maxObservedGapFrames: number | null; maxAllowedGapFrames: number
    unknownSampleFrames: readonly number[]
  }>
  occupants: readonly FaceClearanceOccupant[]
  occupantCount: number
  untrustedEnvelopeHashes: readonly string[]
  scope: Readonly<{
    detector: 'omz-face-detection-0204-v9'
    acceptedFor: 'foreground-faces-and-speaker'
    minConfidence: number
    faceSafety: 'unknown'
    meaning: 'no trusted detection overlaps the area in the sampled evidence; not a statement that no face is present'
  }>
  clearanceHash: string
}>

const OCCUPANT_REPORT_LIMIT = 16
const UNKNOWN_FRAME_REPORT_LIMIT = 16

function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }
function finiteIn01(value: number) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 }

/** Expands a box by max(largerSide x fraction, frame fraction) in pixels per axis, clamped to the frame. */
export function dilateFaceBox(box: readonly [number, number, number, number], frame: Readonly<{ width: number; height: number }>):
  readonly [number, number, number, number] {
  const { largerSideFraction, minFrameFraction } = FACE_EVIDENCE_POLICY.clearance.dilation
  const largerSidePx = Math.max((box[2] - box[0]) * frame.width, (box[3] - box[1]) * frame.height)
  const marginX = Math.max(largerSideFraction * largerSidePx, minFrameFraction * frame.width) / frame.width
  const marginY = Math.max(largerSideFraction * largerSidePx, minFrameFraction * frame.height) / frame.height
  return [Math.max(0, box[0] - marginX), Math.max(0, box[1] - marginY), Math.min(1, box[2] + marginX), Math.min(1, box[3] + marginY)]
}

function overlapsClosed(box: readonly [number, number, number, number], area: Readonly<NormalizedBounds>): boolean {
  return !(box[2] < area.x || box[0] > area.x + area.width || box[3] < area.y || box[1] > area.y + area.height)
}

function validateInput(stream: FaceEvidenceStream, cue: Readonly<{ startFrame: number; endFrame: number }>, area: readonly CaptionAreaRange[]) {
  if (!Number.isSafeInteger(cue.startFrame) || !Number.isSafeInteger(cue.endFrame) || cue.startFrame < 0 ||
      cue.endFrame <= cue.startFrame || cue.endFrame > stream.timelineDurationFrames) invalid('Clearance cue range is invalid')
  if (!Array.isArray(area)) invalid('Caption area must be a list of ranges')
  for (const range of area) {
    const b = range.bounds
    if (!Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrame) || range.endFrame <= range.startFrame ||
        !b || !finiteIn01(b.x) || !finiteIn01(b.y) || !finiteIn01(b.width) || !finiteIn01(b.height) || b.width <= 0 || b.height <= 0 ||
        b.x + b.width > 1 + 1e-9 || b.y + b.height > 1 + 1e-9) invalid('Caption area range is invalid')
  }
}

/** Area ranges (sorted) must tile [start, end) with no hole; otherwise the area is not defined for the span. */
function areaCoversSpan(area: readonly CaptionAreaRange[], start: number, end: number): boolean {
  const ordered = [...area].sort((a, b) => a.startFrame - b.startFrame)
  let cursor = start
  for (const range of ordered) {
    if (range.endFrame <= cursor) continue
    if (range.startFrame > cursor) return false
    cursor = range.endFrame
    if (cursor >= end) return true
  }
  return cursor >= end
}

export function evaluateFaceCaptionClearance(input: Readonly<{
  stream: FaceEvidenceStream
  cue: Readonly<{ startFrame: number; endFrame: number }>
  area: readonly CaptionAreaRange[]
}>): FaceCaptionClearance {
  const { stream, cue, area } = input
  validateInput(stream, cue, area)
  const policy = FACE_EVIDENCE_POLICY.clearance
  const maxGap = maxSampleGapFrames(stream.timelineFps)
  const samples = stream.samples
  const reasons = new Set<string>()
  const occupants: FaceClearanceOccupant[] = []
  let occupantCount = 0

  // Untrusted evidence near the cue (within one gap on either side) makes any answer unreliable.
  const lo = cue.startFrame - maxGap, hi = cue.endFrame + maxGap
  const untrustedNear = stream.untrusted.filter((entry) => entry.startFrame < hi && entry.endFrame > lo)
  if (untrustedNear.length > 0) reasons.add('UNTRUSTED_EVIDENCE_NEAR_CUE')
  if (stream.policySha256 !== FACE_EVIDENCE_POLICY_SHA256) reasons.add('POLICY_MISMATCH')
  if (!areaCoversSpan(area, cue.startFrame, cue.endFrame)) reasons.add('AREA_NOT_DEFINED_FOR_SPAN')

  // Overlap among trusted samples: each sample vouches for the frames between its neighbours.
  const overlapIn = (index: number): FaceClearanceOccupant[] => {
    const sample = samples[index]!
    if (sample.status !== 'observed') return []
    const from = Math.max(cue.startFrame, index === 0 ? sample.timelineFrame : samples[index - 1]!.timelineFrame + 1)
    const to = Math.min(cue.endFrame - 1, index === samples.length - 1 ? sample.timelineFrame : samples[index + 1]!.timelineFrame - 1)
    if (to < from) return []
    const rects = area.filter((range) => range.startFrame <= to && range.endFrame > from)
    const found: FaceClearanceOccupant[] = []
    for (const detection of sample.detections) {
      if (detection.confidence < policy.scoreMin) continue
      const dilated = dilateFaceBox(detection.boxXYXY, { width: sample.frameWidth, height: sample.frameHeight })
      if (rects.some((range) => overlapsClosed(dilated, range.bounds))) {
        found.push(Object.freeze({ timelineFrame: sample.timelineFrame, confidence: detection.confidence,
          boxXYXY: detection.boxXYXY, dilatedXYXY: Object.freeze(dilated) }))
      }
    }
    return found
  }
  samples.forEach((_sample, index) => {
    for (const occupant of overlapIn(index)) {
      occupantCount += 1
      if (occupants.length < OCCUPANT_REPORT_LIMIT) occupants.push(occupant)
    }
  })

  // Coverage: samples bracket the cue, none of them unknown, and no gap wider than the policy allows.
  let before: number | null = null, after: number | null = null
  for (let index = 0; index < samples.length; index += 1) {
    const frame = samples[index]!.timelineFrame
    if (frame <= cue.startFrame) before = index
    if (after === null && frame >= cue.endFrame - 1) after = index
  }
  const unknownFrames: number[] = []
  let maxObservedGap: number | null = null
  let considered = 0, first: number | null = null, last: number | null = null
  if (before === null) reasons.add('NO_SAMPLE_BEFORE_CUE')
  if (after === null) reasons.add('NO_SAMPLE_AFTER_CUE')
  if (before !== null && after !== null) {
    considered = after - before + 1
    first = samples[before]!.timelineFrame; last = samples[after]!.timelineFrame
    for (let index = before; index <= after; index += 1) {
      const sample: FaceEvidenceSample = samples[index]!
      if (sample.status !== 'observed') unknownFrames.push(sample.timelineFrame)
      if (index > before) {
        const gap = sample.timelineFrame - samples[index - 1]!.timelineFrame
        maxObservedGap = Math.max(maxObservedGap ?? 0, gap)
        if (gap > maxGap) reasons.add('SAMPLE_GAP_EXCEEDS_LIMIT')
      }
    }
    if (unknownFrames.length > 0) reasons.add('SAMPLE_UNKNOWN')
  }

  let state: FaceClearanceState
  if (untrustedNear.length > 0 || reasons.has('POLICY_MISMATCH')) state = 'unknown'
  else if (occupantCount > 0) state = 'occupied'
  else if (reasons.size > 0) state = 'unknown'
  else state = 'free-certified'
  if (state === 'occupied') reasons.add('DETECTION_OVERLAPS_AREA')

  const body = {
    schemaVersion: 'face-caption-clearance/v1' as const,
    policySha256: FACE_EVIDENCE_POLICY_SHA256,
    streamHash: stream.streamHash,
    cue: Object.freeze({ startFrame: cue.startFrame, endFrame: cue.endFrame }),
    state,
    reasons: Object.freeze([...reasons].sort()),
    coverage: Object.freeze({ samplesConsidered: considered, firstSampleFrame: first, lastSampleFrame: last,
      maxObservedGapFrames: maxObservedGap, maxAllowedGapFrames: maxGap,
      unknownSampleFrames: Object.freeze(unknownFrames.slice(0, UNKNOWN_FRAME_REPORT_LIMIT)) }),
    occupants: Object.freeze(occupants),
    occupantCount,
    untrustedEnvelopeHashes: Object.freeze(untrustedNear.map((entry) => entry.envelopeHash).sort()),
    scope: Object.freeze({
      detector: 'omz-face-detection-0204-v9' as const, acceptedFor: 'foreground-faces-and-speaker' as const,
      minConfidence: policy.scoreMin, faceSafety: 'unknown' as const,
      meaning: 'no trusted detection overlaps the area in the sampled evidence; not a statement that no face is present' as const,
    }),
  }
  return Object.freeze({ ...body, clearanceHash: calculateCanonicalHash(body) })
}
