import { assertDomain } from './errors.ts'
import { faceSampleIntervalFrames } from './face-evidence-policy.ts'
import type { FaceBoxV2 } from './face-producer-envelope-v2.ts'
import type { FaceSourceEvidenceSample, FaceSourceEvidenceStream } from './face-source-evidence-stream.ts'
import {
  createReframeObservationSetV2,
  type ReframeObservationSetV2, type ReframeObservationV2, type ReframeUnknownRangeV1, type ReframeUnknownReason,
} from './reframe-plan.ts'
import { isPinnedReframePolicy, type ReframePolicyV1 } from './reframe-policy.ts'

/**
 * Server-owned ROI (W66r). Projects the sealed, authenticated face evidence of a SOURCE onto the timeline of one EditPlan, through
 * that plan's own clips, and returns the observations the reframe plan is decided from. The caller supplies no box: every box
 * here comes from a sample of a window envelope that `collectFaceSourceEvidenceStream` accepted, and carries the content address
 * of the envelope it came from.
 *
 * The evidence is SAMPLED (one frame every `stride` frames, 6 Hz for 30 fps). Between samples the rules are:
 *
 * - A sample "owns" the stride that starts at it. Two consecutive samples of ONE clip, both observed, describe their stride by the
 *   envelope of their boxes (a subject that moves between them is inside that union): that is the interpolation, and it is bounded
 *   by one stride.
 * - A sample whose neighbour is unknown, missing or outside the clip is held for its own stride only; the first and the last stride
 *   of a clip extend to the clip's edge (at most `stride - 1` frames beyond the sample).
 * - Nothing crosses a cut (the stride of a clip's last sample stops at the clip's end and the next clip restarts the tracking), an
 *   unknown sample, a gap between windows or a window whose seal was refused: that stride is an UNKNOWN RANGE with its reason, never
 *   "no subject" and never the neighbour's box.
 * - An observed sample with no foreground face is an observed absence (no observation, no unknown range): the plan answers it with
 *   `NO_SUBJECT_OBSERVATION`.
 *
 * Object and screen ROI do not exist: no verified producer is available for either, and the set says so instead of guessing.
 */
export type ReframeRoiClip = Readonly<{
  id: string
  sourceArtifactId: string
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: number
  /** A static crop the editor set on the clip: the clip is not reframed automatically. */
  crop?: unknown
}>

export type ReframeRoiSource = Readonly<{
  artifactId: string
  manifestId: string
  sha256: string
  width: number
  height: number
}>

type Box = Readonly<{ x: number; y: number; width: number; height: number; confidence: number }>

const ENVELOPE_ID = (hash: string) => `face-envelope:${hash}`

function boxesOf(sample: FaceSourceEvidenceSample, policy: ReframePolicyV1): readonly Box[] {
  const face = policy.roi.face
  const boxes: Box[] = []
  for (const detection of sample.detections as readonly FaceBoxV2[]) {
    const [x1, y1, x2, y2] = detection.boxXYXY
    // Only a box that is a candidate at all, and big enough to be the foreground, is a subject. A small face is background.
    if (detection.confidence < face.includeScoreMin || y2 - y1 < face.foregroundMinHeightFraction) continue
    boxes.push(Object.freeze({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, confidence: detection.confidence }))
  }
  return boxes.toSorted((left, right) => left.x - right.x || left.y - right.y || right.confidence - left.confidence)
}

function iou(left: Box, right: Box): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  if (width <= 0 || height <= 0) return 0
  const overlap = width * height
  return overlap / (left.width * left.height + right.width * right.height - overlap)
}

function near(left: Box, right: Box, maxHeights: number): boolean {
  const distance = Math.hypot(left.x + left.width / 2 - right.x - right.width / 2, left.y + left.height / 2 - right.y - right.height / 2)
  return distance <= maxHeights * Math.max(left.height, right.height)
}

/** Greedy one-to-one pairing of the boxes of two consecutive samples; unpaired boxes stay alone. No identity is claimed. */
function groupBoxes(first: readonly Box[], second: readonly Box[], policy: ReframePolicyV1): readonly (readonly Box[])[] {
  const face = policy.roi.face
  const candidates: Array<{ left: number; right: number; score: number }> = []
  first.forEach((left, leftIndex) => second.forEach((right, rightIndex) => {
    const overlap = iou(left, right)
    if (overlap >= face.pairingMinIou || near(left, right, face.pairingMaxCenterDistanceBoxHeights)) {
      candidates.push({ left: leftIndex, right: rightIndex, score: overlap + 1 / (1 + Math.hypot(left.x - right.x, left.y - right.y)) })
    }
  }))
  candidates.sort((a, b) => b.score - a.score || a.left - b.left || a.right - b.right)
  const usedLeft = new Set<number>(), usedRight = new Set<number>()
  const groups: Box[][] = []
  for (const candidate of candidates) {
    if (usedLeft.has(candidate.left) || usedRight.has(candidate.right)) continue
    usedLeft.add(candidate.left); usedRight.add(candidate.right)
    groups.push([first[candidate.left]!, second[candidate.right]!])
  }
  first.forEach((box, index) => { if (!usedLeft.has(index)) groups.push([box]) })
  second.forEach((box, index) => { if (!usedRight.has(index)) groups.push([box]) })
  return groups.toSorted((a, b) => Math.min(...a.map((box) => box.x)) - Math.min(...b.map((box) => box.x)))
}

function merge(group: readonly Box[]) {
  const x = Math.min(...group.map((box) => box.x)), y = Math.min(...group.map((box) => box.y))
  const right = Math.max(...group.map((box) => box.x + box.width)), bottom = Math.max(...group.map((box) => box.y + box.height))
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return Object.freeze({
    bounds: Object.freeze({ x: clamp(x), y: clamp(y), width: Math.max(1e-6, Math.min(1, right) - clamp(x)), height: Math.max(1e-6, Math.min(1, bottom) - clamp(y)) }),
    confidence: Math.min(...group.map((box) => box.confidence)),
    strongest: Math.max(...group.map((box) => box.confidence)),
  })
}

export function projectFaceEvidenceToReframeObservations(input: Readonly<{
  id: string
  manifestId?: string
  fps: number
  durationFrames: number
  source: ReframeRoiSource
  clips: readonly ReframeRoiClip[]
  stream: Readonly<FaceSourceEvidenceStream>
  policy: ReframePolicyV1
}>): Readonly<ReframeObservationSetV2> {
  assertDomain(isPinnedReframePolicy(input.policy), 'INVALID_RENDER_INPUT', 'Reframe policy is not the pinned reframe-policy/v1')
  assertDomain(Number.isInteger(input.fps) && input.fps >= 1 && input.fps <= 120, 'INVALID_RENDER_INPUT', 'Face evidence maps onto an integer timeline frame rate only')
  assertDomain(input.stream.sourceArtifactId === input.source.artifactId && input.stream.sourceSha256 === input.source.sha256,
    'INVALID_RENDER_INPUT', 'The evidence stream is not about the source being reframed')
  assertDomain(input.stream.sourceFps.num === input.fps && input.stream.sourceFps.den === 1,
    'INVALID_RENDER_INPUT', 'The evidence stream was measured on another frame rate than the timeline')
  const stride = faceSampleIntervalFrames({ num: input.fps, den: 1 })
  const bySourceFrame = new Map<number, FaceSourceEvidenceSample>(input.stream.samples.map((sample) => [sample.sourceFrame, sample]))
  const streamRef = Object.freeze({
    id: `face-stream-${input.stream.streamHash.slice(0, 40)}`, kind: 'face-source-evidence-stream' as const,
    sourceArtifactId: input.source.artifactId, streamHash: input.stream.streamHash, policySha256: input.stream.policySha256,
    trustedEnvelopeHashes: Object.freeze(input.stream.trustedWindows.map((window) => window.envelopeHash).toSorted()),
    untrusted: Object.freeze(input.stream.untrusted.map((entry) => Object.freeze({ envelopeHash: entry.envelopeHash, reasons: Object.freeze([...entry.reasons]) }))
      .toSorted((left, right) => left.envelopeHash.localeCompare(right.envelopeHash))),
  })
  const untrustedAt = (sourceFrame: number) => input.stream.untrusted.filter((entry) => entry.startSourceFrame <= sourceFrame && sourceFrame < entry.endSourceFrame)

  const observations: ReframeObservationV2[] = []
  const unknown: Array<{ startFrame: number; endFrame: number; reasonCode: ReframeUnknownReason; evidenceIds: Set<string> }> = []
  const markUnknown = (startFrame: number, endFrame: number, reasonCode: ReframeUnknownReason, evidenceIds: readonly string[]) => {
    if (endFrame <= startFrame) return
    const previous = unknown.at(-1)
    if (previous && previous.endFrame === startFrame && previous.reasonCode === reasonCode && previous.evidenceIds.size + evidenceIds.length <= 8) {
      previous.endFrame = endFrame
      evidenceIds.forEach((id) => previous.evidenceIds.add(id))
      return
    }
    unknown.push({ startFrame, endFrame, reasonCode, evidenceIds: new Set(evidenceIds) })
  }

  const clips = input.clips.toSorted((left, right) => left.timelineInFrame - right.timelineInFrame)
  let timelineCursor = 0
  let observedSamples = 0
  const trackingBreaks: number[] = []
  for (const clip of clips) {
    assertDomain(clip.timelineInFrame >= timelineCursor && clip.timelineOutFrame > clip.timelineInFrame && clip.timelineOutFrame <= input.durationFrames,
      'INVALID_RENDER_INPUT', 'Reframe clips must be ordered, disjoint and inside the timeline')
    // Frames no clip plays are not evidence of anything.
    markUnknown(timelineCursor, clip.timelineInFrame, 'UNSUPPORTED_CLIP', [])
    timelineCursor = clip.timelineOutFrame
    if (clip.timelineInFrame > 0) trackingBreaks.push(clip.timelineInFrame)
    const spansEqual = clip.sourceOutFrame - clip.sourceInFrame === clip.timelineOutFrame - clip.timelineInFrame
    if (clip.rate !== 1 || !spansEqual || clip.sourceArtifactId !== input.source.artifactId || (clip.crop !== undefined && clip.crop !== null)) {
      markUnknown(clip.timelineInFrame, clip.timelineOutFrame, 'UNSUPPORTED_CLIP', [])
      continue
    }
    const offset = clip.sourceInFrame - clip.timelineInFrame
    const toTimeline = (sourceFrame: number) => sourceFrame - offset
    // The sample frames that fall inside this clip. A sample outside it belongs to another stretch of the source: not used.
    const sampleFrames: number[] = []
    for (let frame = Math.ceil(clip.sourceInFrame / stride) * stride; frame < clip.sourceOutFrame; frame += stride) sampleFrames.push(frame)
    if (sampleFrames.length === 0) {
      markUnknown(clip.timelineInFrame, clip.timelineOutFrame, 'WINDOW_GAP', [])
      continue
    }
    sampleFrames.forEach((frame, position) => {
      const slotStart = position === 0 ? clip.sourceInFrame : frame
      const slotEnd = position === sampleFrames.length - 1 ? clip.sourceOutFrame : sampleFrames[position + 1]!
      const first = bySourceFrame.get(frame)
      const start = toTimeline(slotStart), end = toTimeline(slotEnd)
      if (!first || first.status !== 'observed') {
        const refused = untrustedAt(frame)
        if (first) markUnknown(start, end, 'UNKNOWN_SAMPLE', [ENVELOPE_ID(first.envelopeHash)])
        else if (refused.length) markUnknown(start, end, 'UNTRUSTED_EVIDENCE', refused.map((entry) => ENVELOPE_ID(entry.envelopeHash)).slice(0, 8))
        else markUnknown(start, end, 'WINDOW_GAP', [streamRef.id])
        return
      }
      observedSamples += 1
      const second = position + 1 < sampleFrames.length ? bySourceFrame.get(sampleFrames[position + 1]!) : undefined
      const pair = second && second.status === 'observed' ? second : undefined
      const groups = groupBoxes(boxesOf(first, input.policy), pair ? boxesOf(pair, input.policy) : [], input.policy)
      const evidenceIds = [ENVELOPE_ID(first.envelopeHash), ...(pair && pair.envelopeHash !== first.envelopeHash ? [ENVELOPE_ID(pair.envelopeHash)] : [])]
      groups.forEach((group, index) => {
        const merged = merge(group)
        observations.push(Object.freeze({
          id: `roi-face-${start}-${index}`, subjectId: `face-group-${index}`, kind: 'face' as const, startFrame: start, endFrame: end,
          bounds: merged.bounds, confidence: merged.confidence, priority: input.policy.roi.face.priority,
          critical: merged.strongest >= input.policy.roi.face.criticalScoreMin, evidenceIds: Object.freeze(evidenceIds),
        }))
      })
    })
  }
  markUnknown(timelineCursor, input.durationFrames, 'UNSUPPORTED_CLIP', [])

  const unknownRanges: ReframeUnknownRangeV1[] = unknown.map((range) => Object.freeze({
    id: `unknown-${range.startFrame}-${range.reasonCode.toLowerCase().replaceAll('_', '-')}`, startFrame: range.startFrame, endFrame: range.endFrame,
    reasonCode: range.reasonCode, evidenceIds: Object.freeze([...range.evidenceIds].toSorted()),
  }))
  const face = observedSamples === 0 && observations.length === 0
    ? { status: 'absent' as const, reasonCode: 'NO_TRUSTED_FACE_EVIDENCE' }
    : unknownRanges.length > 0 ? { status: 'partial' as const, reasonCode: 'EVIDENCE_GAPS' } : { status: 'present' as const, reasonCode: null }
  return createReframeObservationSetV2({
    id: input.id, sourceArtifactId: input.source.artifactId, sourceManifestId: input.manifestId ?? input.source.manifestId,
    sourceSha256: input.source.sha256, sourceWidth: input.source.width, sourceHeight: input.source.height, fps: input.fps,
    durationFrames: input.durationFrames, evidence: Object.freeze([streamRef]),
    roi: Object.freeze({
      face: Object.freeze(face),
      object: Object.freeze({ ...input.policy.roi.object }), screen: Object.freeze({ ...input.policy.roi.screen }),
    }),
    observations: Object.freeze(observations), unknownRanges: Object.freeze(unknownRanges), trackingBreaks: Object.freeze(trackingBreaks),
  })
}
