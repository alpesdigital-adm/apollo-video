import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { sourceRectCanvasSegments, type CaptionProjection } from './caption-canvas-projection.ts'
import {
  BAND_EVALUATION_KINDS, combineClearanceStates, evaluateBandFaceClearance, unprojectableBandClearance,
  type BandFaceClearanceV1, type FaceEvidenceForSource,
} from './caption-face-clearance.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from './face-evidence-policy.ts'
import type { NormalizedBounds, OutputAspectRatio, OutputSpec } from './output-spec.ts'
import { queryPerceptionRange, type PerceptionTimeline } from './perception-timeline.ts'
import {
  CRITICAL_BLOCKER_KINDS, DEFAULT_SUBTITLE_ANCHOR_POLICY, deriveSubtitleAnchorBands, frameToMs, FULL_CANVAS, msToFrame,
  overlaps, PERCEPTION_BLOCKER_KIND, PERCEPTION_BLOCKER_KINDS, readObservationBounds, SUBTITLE_ANCHOR_PREFERENCE,
  type OcrEvidenceIdentity, type SubtitleAnchorBlockerV1, type SubtitleAnchorCueV1, type SubtitleAnchorDecisionV1,
  type SubtitleAnchorIssueV1, type SubtitleAnchorPlanBase, type SubtitleAnchorPolicyV1, type SubtitleAnchorReasonCode,
} from './subtitle-anchor-plan.ts'
import type { SubtitleRegionV1 } from './subtitle-region.ts'
import type { SubtitleAnchor } from './subtitle-system.ts'

/**
 * `subtitle-anchor-plan/v3` (W65): the anchor of every cue is decided from the THREE-STATE face clearance of each of the
 * five bands, measured on the variant's own canvas through the render's single source<->canvas projection.
 *
 * - a band is eligible only when its face clearance is `free-certified` (and, strictly, nothing else blocks it);
 * - `occupied` and `unknown` bands are never candidates, not even as a relaxed fallback;
 * - a cue with no eligible band is `blocked` (every band is taken: `NO_SAFE_SUBTITLE_REGION`) or `review-required`
 *   (at least one band could not be certified: `FACE_PERCEPTION_UNAVAILABLE`). Neither is drawn, in the proxy or in the
 *   final: the plan carries the cue text's band candidates as data for the review UI, never as burned pixels.
 *
 * `free-certified` keeps the W62 meaning (no trusted detection overlaps the band in the sampled evidence). The plan
 * therefore never claims facial safety: `faceClearance.faceSafety` is the literal `unknown`.
 *
 * Every decision is a pure function of the per-band assessments it records, so `validateSubtitleAnchorPlanV3` re-derives
 * each one: a rewritten band state, a moved anchor or an edited hash cannot reach the renderer.
 */
export const FACE_CLEARANCE_MEANING =
  'free-certified: no trusted detection overlaps the band in the sampled evidence; not a statement that no face is present' as const
// v2 (W65b): the evidence streams are keyed by SOURCE frames (and may be explicitly unavailable); v1 streams were keyed by the timeline.
export const FACE_CLEARANCE_EVIDENCE_SCHEMA = 'face-clearance-evidence/v2' as const

export type SubtitleAnchorBandAssessmentV1 = Readonly<{
  face: BandFaceClearanceV1
  /** Non-face evidence overlapping the band during the stability window (OCR, inserts, CTA, logo). */
  blockerIds: readonly string[]
  /** The subset of `blockerIds` that may never be relaxed (a face observation of the perception timeline). */
  criticalBlockerIds: readonly string[]
}>
export type SubtitleAnchorDispositionV3 = 'placed' | 'blocked' | 'review-required'
export type SubtitleAnchorDecisionV3 = Readonly<SubtitleAnchorDecisionV1 & {
  disposition: SubtitleAnchorDispositionV3
  /** Half-open window the band assessments were measured over: the cue, extended so a decision cannot be undone one cue later. */
  stabilityWindow: Readonly<{ startFrame: number; endFrame: number }>
  bandAssessments: Readonly<Record<SubtitleAnchor, SubtitleAnchorBandAssessmentV1>>
}>
export type FaceClearanceEvidenceV1 = Readonly<{
  schemaVersion: typeof FACE_CLEARANCE_EVIDENCE_SCHEMA
  policySha256: string
  faceSafety: 'unknown'
  meaning: typeof FACE_CLEARANCE_MEANING
  /** `null` when the projection could not be established (a source dimension was unknown): every band is then unknown. */
  projectionHash: string | null
  streams: readonly Readonly<{
    sourceArtifactId: string
    /** `null` when no stream could be used for this source; `unavailableReason` then says why (never a silent absence). */
    streamHash: string | null
    sourceSha256: string | null
    /** The frame domain of every frame number in this entry and in the plan's `sourceRange`s. */
    frameDomain: 'source'
    sourceFps: Readonly<{ num: number; den: number }> | null
    unavailableReason: string | null
    trustedEnvelopeHashes: readonly string[]
    untrusted: readonly Readonly<{ envelopeHash: string; startSourceFrame: number; endSourceFrame: number; reasons: readonly string[] }>[]
  }>[]
  evidenceHash: string
}>
export type SubtitleAnchorPlanV3 = Readonly<Omit<SubtitleAnchorPlanBase, 'decisions'> & {
  schemaVersion: 'subtitle-anchor-plan/v3'
  faceClearance: FaceClearanceEvidenceV1
  ocrEvidence?: OcrEvidenceIdentity
  decisions: readonly Readonly<SubtitleAnchorDecisionV3>[]
}>

const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STATES = Object.freeze(['free-certified', 'occupied', 'unknown'] as const)

function buildFaceClearanceEvidence(projection: Readonly<CaptionProjection> | null, evidence: readonly FaceEvidenceForSource[]): FaceClearanceEvidenceV1 {
  const streams = Object.freeze(evidence.map((entry) => Object.freeze(entry.stream === null ? {
    sourceArtifactId: entry.sourceArtifactId, streamHash: null, sourceSha256: null, frameDomain: 'source' as const, sourceFps: null,
    unavailableReason: entry.unavailableReason, trustedEnvelopeHashes: Object.freeze([] as string[]),
    untrusted: Object.freeze([] as { envelopeHash: string; startSourceFrame: number; endSourceFrame: number; reasons: readonly string[] }[]),
  } : {
    sourceArtifactId: entry.sourceArtifactId,
    streamHash: entry.stream.streamHash,
    sourceSha256: entry.stream.sourceSha256,
    frameDomain: 'source' as const,
    sourceFps: Object.freeze({ ...entry.stream.sourceFps }),
    unavailableReason: null,
    trustedEnvelopeHashes: Object.freeze(entry.stream.trustedWindows.map((window) => window.envelopeHash).toSorted()),
    untrusted: Object.freeze(entry.stream.untrusted.map((item) => Object.freeze({
      envelopeHash: item.envelopeHash, startSourceFrame: item.startSourceFrame, endSourceFrame: item.endSourceFrame, reasons: Object.freeze([...item.reasons]),
    }))),
  })).toSorted((left, right) => left.sourceArtifactId.localeCompare(right.sourceArtifactId)))
  const body = Object.freeze({
    schemaVersion: FACE_CLEARANCE_EVIDENCE_SCHEMA,
    policySha256: FACE_EVIDENCE_POLICY_SHA256,
    faceSafety: 'unknown' as const,
    meaning: FACE_CLEARANCE_MEANING,
    projectionHash: projection?.projectionHash ?? null,
    streams,
  })
  return Object.freeze({ ...body, evidenceHash: calculateCanonicalHash(body) })
}

/**
 * Non-face blockers on the CANVAS: OCR, inserts and (as a hard stop) faces of a perception timeline are expressed in the
 * normalized space of the source frame and are projected onto the canvas; CTA and logo placements already live there.
 */
function collectBlockersV3(input: Readonly<{
  timeline?: Readonly<PerceptionTimeline>
  perceptionSourceArtifactId: string | null
  projection: Readonly<CaptionProjection> | null
  placements: readonly Readonly<{ elementId: string; kind: string; bounds: Readonly<NormalizedBounds>; timeRange: Readonly<{ startFrame: number; endFrame: number }> }>[]
  fps: number
  durationFrames: number
}>): Readonly<{ blockers: readonly Readonly<SubtitleAnchorBlockerV1>[]; withoutGeometry: readonly string[] }> {
  const blockers: SubtitleAnchorBlockerV1[] = []
  const withoutGeometry: string[] = []
  if (input.timeline) {
    const endMs = Math.min(input.timeline.durationMs, Math.max(1, frameToMs(input.durationFrames, input.fps)))
    const queried = queryPerceptionRange(input.timeline, { startMs: 0, endMs, kinds: PERCEPTION_BLOCKER_KINDS })
    for (const observation of queried.observations) {
      const kind = PERCEPTION_BLOCKER_KIND[observation.kind as keyof typeof PERCEPTION_BLOCKER_KIND]
      if (!kind) continue
      const bounds = readObservationBounds(observation.value)
      const critical = CRITICAL_BLOCKER_KINDS.includes(kind as (typeof CRITICAL_BLOCKER_KINDS)[number])
      const startFrame = Math.max(0, Math.min(input.durationFrames - 1, msToFrame(observation.startMs, input.fps)))
      const endFrame = Math.max(1, Math.min(input.durationFrames, msToFrame(observation.endMs, input.fps)))
      if (endFrame <= startFrame) continue
      if (!bounds) {
        withoutGeometry.push(observation.id)
        if (!critical) continue
        blockers.push(Object.freeze({ id: observation.id, kind, source: 'perception' as const, critical: true, bounds: FULL_CANVAS, startFrame, endFrame }))
        continue
      }
      if (!input.projection) continue
      for (const segment of sourceRectCanvasSegments(input.projection, bounds, input.perceptionSourceArtifactId, { startFrame, endFrame })) {
        blockers.push(Object.freeze({
          id: observation.id, kind, source: 'perception' as const, critical, bounds: segment.bounds,
          startFrame: segment.startFrame, endFrame: segment.endFrame,
        }))
      }
    }
  }
  for (const placement of input.placements) {
    if (placement.kind !== 'cta' && placement.kind !== 'logo') continue
    blockers.push(Object.freeze({
      id: placement.elementId, kind: placement.kind, source: 'placement-plan' as const,
      critical: false, bounds: Object.freeze({ ...placement.bounds }),
      startFrame: placement.timeRange.startFrame, endFrame: placement.timeRange.endFrame,
    }))
  }
  return Object.freeze({
    blockers: Object.freeze(blockers.filter((blocker) => blocker.endFrame > blocker.startFrame)
      .toSorted((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))),
    withoutGeometry: Object.freeze([...new Set(withoutGeometry)].toSorted()),
  })
}

const unique = (values: readonly string[]) => Object.freeze([...new Set(values)].toSorted())

/**
 * The decision for one cue, as a pure function of the band assessments it records, the previous anchor and the policy.
 * Creation and validation both go through here, so they cannot disagree.
 */
export function deriveCueDecisionV3(input: Readonly<{
  cue: Readonly<SubtitleAnchorCueV1>
  stabilityWindow: Readonly<{ startFrame: number; endFrame: number }>
  assessments: Readonly<Record<SubtitleAnchor, SubtitleAnchorBandAssessmentV1>>
  bands: Readonly<Record<SubtitleAnchor, Readonly<NormalizedBounds>>>
  previous: SubtitleAnchor | null
  lastChangeFrame: number | null
  policy: Readonly<SubtitleAnchorPolicyV1>
  fps: number
}>): Readonly<{ decision: Readonly<SubtitleAnchorDecisionV3>; lastChangeFrame: number | null }> {
  const { cue, assessments, bands, previous, policy } = input
  const strict: SubtitleAnchor[] = [], relaxed: SubtitleAnchor[] = []
  let anyUnknown = false
  for (const anchor of SUBTITLE_ANCHOR_PREFERENCE) {
    const assessment = assessments[anchor]
    if (assessment.face.state === 'unknown') anyUnknown = true
    if (assessment.face.state !== 'free-certified') continue
    if (assessment.blockerIds.length === 0) strict.push(anchor)
    else if (assessment.criticalBlockerIds.length === 0) relaxed.push(anchor)
  }
  const blockingIds = unique(SUBTITLE_ANCHOR_PREFERENCE.flatMap((anchor) => assessments[anchor].blockerIds))
  const faceEvaluations = SUBTITLE_ANCHOR_PREFERENCE.flatMap((anchor) => assessments[anchor].face.evaluations)
  const allFaceIds = faceEvaluations.filter((entry) => entry.clearanceHash).map((entry) => `face-clearance:${entry.clearanceHash}`)
  const notFreeFaceIds = faceEvaluations.filter((entry) => entry.clearanceHash && entry.state !== 'free-certified').map((entry) => `face-clearance:${entry.clearanceHash}`)
  const issues: SubtitleAnchorIssueV1[] = []
  const range = Object.freeze({ startFrame: cue.startFrame, endFrame: cue.endFrame })
  const rangeMs = Object.freeze([frameToMs(cue.startFrame, input.fps), frameToMs(cue.endFrame, input.fps)] as const)
  const addIssue = (code: SubtitleAnchorReasonCode, severity: 'hard' | 'warning', message: string, evidence: readonly string[]) => {
    issues.push(Object.freeze({
      code, severity, cueId: cue.id, evidenceRange: range, rangeMs,
      elementIds: Object.freeze([`subtitle:${cue.id}`]), evidenceIds: unique(evidence), message,
    }))
  }
  let anchor: SubtitleAnchor | null = null
  let disposition: SubtitleAnchorDispositionV3 = 'placed'
  if (previous !== null && strict.includes(previous)) anchor = previous
  else if (strict.length > 0) anchor = strict[0]!
  else if (relaxed.length > 0) {
    anchor = (previous !== null && relaxed.includes(previous)) ? previous : relaxed[0]!
    addIssue('SUBTITLE_ANCHOR_FALLBACK', 'warning',
      `No subtitle band is free for cue ${cue.id}; the ${anchor} band was used and overlaps non-critical evidence.`,
      assessments[anchor].blockerIds)
  } else {
    assertDomain(
      policy.onNoSafeRegion === 'suppress-cue' || policy.onNoSafeRegion === 'omit-and-list',
      'INVALID_RENDER_INPUT', `No safe subtitle region for cue ${cue.id}`, { cueId: cue.id },
    )
    // `omit-and-list` (W65b) keeps the cue out of the pixels exactly like `suppress-cue` does, but lists it as a review item
    // (a warning) instead of making the render unapprovable (a hard issue): the rest of the video can be delivered without it.
    const severity = policy.onNoSafeRegion === 'omit-and-list' ? 'warning' as const : 'hard' as const
    const listed = severity === 'warning' ? ' It was omitted from the render and is listed for review.' : ''
    if (anyUnknown) {
      disposition = 'review-required'
      const reasons = unique(SUBTITLE_ANCHOR_PREFERENCE.flatMap((candidate) => assessments[candidate].face.state === 'unknown' ? assessments[candidate].face.reasons : []))
      addIssue('FACE_PERCEPTION_UNAVAILABLE', severity,
        `Facial clearance could not be certified for any band during cue ${cue.id} (${reasons.slice(0, 6).join(', ') || 'no reason recorded'}); the cue was not drawn and needs review.${listed}`,
        [...blockingIds, ...notFreeFaceIds])
    } else {
      disposition = 'blocked'
      addIssue('NO_SAFE_SUBTITLE_REGION', severity,
        `Every subtitle band collides with protected evidence during cue ${cue.id}; the cue was suppressed instead of covering it.${listed}`,
        [...blockingIds, ...notFreeFaceIds])
    }
  }
  const suppressed = anchor === null
  const stable = anchor !== null && previous !== null && anchor === previous
  const changedFromPrevious = anchor !== null && previous !== null && anchor !== previous
  if (changedFromPrevious && input.lastChangeFrame !== null && cue.startFrame - input.lastChangeFrame < policy.minFramesBetweenChanges) {
    addIssue('SUBTITLE_ANCHOR_UNSTABLE', 'warning',
      `Cue ${cue.id} had to move from ${previous} to ${anchor} only ${cue.startFrame - input.lastChangeFrame} frames after the previous change.`,
      [...blockingIds, ...allFaceIds])
  }
  const decision: SubtitleAnchorDecisionV3 = Object.freeze({
    cueId: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame,
    anchor, bounds: anchor ? bands[anchor] : null,
    stable, changedFromPrevious, suppressed,
    eligibleAnchors: Object.freeze([...strict]),
    blockerIds: unique([...blockingIds, ...notFreeFaceIds]),
    evidenceIds: unique([...blockingIds, ...allFaceIds]),
    issues: Object.freeze([...issues]),
    disposition,
    stabilityWindow: Object.freeze({ startFrame: input.stabilityWindow.startFrame, endFrame: input.stabilityWindow.endFrame }),
    bandAssessments: assessments,
  })
  const lastChangeFrame = anchor !== null && (changedFromPrevious || previous === null) ? cue.startFrame : input.lastChangeFrame
  return Object.freeze({ decision, lastChangeFrame })
}

function sortedIssues(decisions: readonly Readonly<SubtitleAnchorDecisionV3>[]): readonly Readonly<SubtitleAnchorIssueV1>[] {
  return Object.freeze(decisions.flatMap((decision) => decision.issues).toSorted((left, right) =>
    left.evidenceRange.startFrame - right.evidenceRange.startFrame || left.code.localeCompare(right.code) || left.cueId.localeCompare(right.cueId)))
}

function stabilityWindowOf(cue: Readonly<SubtitleAnchorCueV1>, durationFrames: number, policy: Readonly<SubtitleAnchorPolicyV1>) {
  return Object.freeze({
    startFrame: cue.startFrame,
    endFrame: Math.min(durationFrames, Math.max(cue.endFrame, cue.startFrame + policy.minFramesBetweenChanges)),
  })
}

export function createSubtitleAnchorPlanV3(input: Readonly<{
  spec: Readonly<OutputSpec>
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  fps: number
  durationFrames: number
  region: Readonly<SubtitleRegionV1>
  cues: readonly Readonly<SubtitleAnchorCueV1>[]
  perceptionTimeline?: Readonly<PerceptionTimeline>
  /** The source the perception timeline was measured on; `null` projects it through every clip. */
  perceptionSourceArtifactId?: string | null
  placements?: readonly Readonly<{ elementId: string; kind: string; bounds: Readonly<NormalizedBounds>; timeRange: Readonly<{ startFrame: number; endFrame: number }> }>[]
  policy?: Partial<SubtitleAnchorPolicyV1>
  ocrEvidence?: OcrEvidenceIdentity
  /** `null` when the render's sources could not all be measured: every band is then `unknown`. */
  projection: Readonly<CaptionProjection> | null
  projectionUnavailableReason?: string
  faceEvidence: readonly FaceEvidenceForSource[]
}>): Readonly<SubtitleAnchorPlanV3> {
  assertDomain(
    Number.isFinite(input.fps) && input.fps > 0 && Number.isSafeInteger(input.durationFrames) && input.durationFrames >= 1,
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan timeline is invalid',
  )
  const policy = Object.freeze({ ...DEFAULT_SUBTITLE_ANCHOR_POLICY, ...input.policy })
  assertDomain(
    Number.isSafeInteger(policy.minFramesBetweenChanges) && policy.minFramesBetweenChanges >= 0 &&
    (policy.onNoSafeRegion === 'suppress-cue' || policy.onNoSafeRegion === 'omit-and-list' || policy.onNoSafeRegion === 'fail-closed'),
    'INVALID_RENDER_INPUT', 'Subtitle anchor policy is invalid',
  )
  assertDomain(input.perceptionTimeline === undefined
    ? input.ocrEvidence === undefined
    : input.ocrEvidence !== undefined && ID.test(input.ocrEvidence.envelopeId) &&
      ID.test(input.ocrEvidence.inputVersionId) && SHA256.test(input.ocrEvidence.envelopeHash) &&
      SHA256.test(input.ocrEvidence.timeMapHash),
  'INVALID_RENDER_INPUT', 'Runtime OCR timeline requires sealed envelope identity')
  if (input.projection) {
    assertDomain(
      input.projection.canvas.width === input.canvas.width && input.projection.canvas.height === input.canvas.height,
      'INVALID_RENDER_INPUT', 'The caption projection does not describe this canvas',
    )
  }
  const bands = deriveSubtitleAnchorBands({ region: input.region, safeArea: input.spec.safeArea })
  const placements = input.placements ?? []
  const { blockers, withoutGeometry } = collectBlockersV3({
    ...(input.perceptionTimeline ? { timeline: input.perceptionTimeline } : {}),
    perceptionSourceArtifactId: input.perceptionSourceArtifactId ?? null,
    projection: input.projection, placements, fps: input.fps, durationFrames: input.durationFrames,
  })
  const cues = [...input.cues].toSorted((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))
  const decisions: SubtitleAnchorDecisionV3[] = []
  let previous: SubtitleAnchor | null = null
  let lastChangeFrame: number | null = null
  for (const cue of cues) {
    assertDomain(
      ID.test(cue.id) && Number.isSafeInteger(cue.startFrame) && Number.isSafeInteger(cue.endFrame) &&
      cue.startFrame >= 0 && cue.endFrame > cue.startFrame && cue.endFrame <= input.durationFrames,
      'INVALID_RENDER_INPUT', `Subtitle anchor cue ${cue.id} is not inside the timeline`,
    )
    const stabilityWindow = stabilityWindowOf(cue, input.durationFrames, policy)
    const active = blockers.filter((blocker) => blocker.startFrame < stabilityWindow.endFrame && blocker.endFrame > cue.startFrame)
    const assessments = Object.fromEntries(SUBTITLE_ANCHOR_PREFERENCE.map((anchor) => {
      const band = bands[anchor]
      const hits = active.filter((blocker) => overlaps(band, blocker.bounds))
      const face = input.projection
        ? evaluateBandFaceClearance({ projection: input.projection, evidence: input.faceEvidence, band, window: stabilityWindow })
        : unprojectableBandClearance(stabilityWindow, input.projectionUnavailableReason ?? 'PROJECTION_UNAVAILABLE')
      return [anchor, Object.freeze({
        face,
        blockerIds: unique(hits.map((blocker) => blocker.id)),
        criticalBlockerIds: unique(hits.filter((blocker) => blocker.critical).map((blocker) => blocker.id)),
      })]
    })) as Record<SubtitleAnchor, SubtitleAnchorBandAssessmentV1>
    const derived: Readonly<{ decision: Readonly<SubtitleAnchorDecisionV3>; lastChangeFrame: number | null }> = deriveCueDecisionV3({ cue, stabilityWindow, assessments: Object.freeze(assessments), bands, previous, lastChangeFrame, policy, fps: input.fps })
    decisions.push(derived.decision as SubtitleAnchorDecisionV3)
    lastChangeFrame = derived.lastChangeFrame
    if (derived.decision.anchor !== null) previous = derived.decision.anchor
  }
  const body = Object.freeze({
    schemaVersion: 'subtitle-anchor-plan/v3' as const,
    outputSpecId: input.spec.id,
    format: input.format,
    canvas: Object.freeze({ width: input.canvas.width, height: input.canvas.height }),
    fps: Number(input.fps.toFixed(6)),
    durationFrames: input.durationFrames,
    subtitleRegionHash: calculateCanonicalHash(input.region),
    presetId: input.region.presetId,
    presetHash: input.region.presetHash,
    registryHash: input.region.registryHash,
    perceptionTimelineHash: input.perceptionTimeline?.timelineHash ?? null,
    placementEvidenceHash: calculateCanonicalHash(Object.freeze(
      blockers.filter((blocker) => blocker.source === 'placement-plan')
        .map((blocker) => Object.freeze({ id: blocker.id, kind: blocker.kind, bounds: blocker.bounds, startFrame: blocker.startFrame, endFrame: blocker.endFrame })),
    )),
    policy,
    bands,
    faceClearance: buildFaceClearanceEvidence(input.projection, input.faceEvidence),
    ...(input.ocrEvidence ? { ocrEvidence: Object.freeze({ ...input.ocrEvidence }) } : {}),
    decisions: Object.freeze(decisions),
    issues: sortedIssues(decisions),
    evidenceWithoutGeometry: withoutGeometry,
  })
  return Object.freeze({ ...body, anchorPlanHash: calculateCanonicalHash(body) })
}

/**
 * Fail-closed gate for a v3 plan. Everything the plan claims is re-derived from what it records: the bands from the
 * region, each band's state from its evaluations, and each decision (anchor, disposition, hysteresis, issues) from the
 * band assessments.
 */
export function validateSubtitleAnchorPlanV3(plan: Readonly<SubtitleAnchorPlanV3>, expected: Readonly<{
  region: Readonly<SubtitleRegionV1>
  safeArea: Readonly<OutputSpec['safeArea']>
  outputSpecId: string
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  durationFrames: number
  /** When the verifier re-derived the projection, the identity the plan must be bound to. */
  projectionHash?: string | null
}>): void {
  assertDomain(plan.schemaVersion === 'subtitle-anchor-plan/v3', 'INVALID_RENDER_INPUT', 'Subtitle anchor plan schema version is unsupported')
  assertDomain(
    plan.outputSpecId === expected.outputSpecId && plan.format === expected.format &&
    plan.canvas.width === expected.canvas.width && plan.canvas.height === expected.canvas.height &&
    plan.durationFrames === expected.durationFrames,
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan does not describe this render',
  )
  assertDomain(
    plan.subtitleRegionHash === calculateCanonicalHash(expected.region) &&
    plan.presetId === expected.region.presetId && plan.presetHash === expected.region.presetHash &&
    plan.registryHash === expected.region.registryHash,
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan is not bound to the resolved subtitle region',
  )
  assertDomain(plan.perceptionTimelineHash === null || SHA256.test(plan.perceptionTimelineHash), 'INVALID_RENDER_INPUT', 'Subtitle anchor plan perception identity is invalid')
  assertDomain((plan.perceptionTimelineHash === null) === (plan.ocrEvidence === undefined) &&
    (!plan.ocrEvidence || (
      ID.test(plan.ocrEvidence.envelopeId) && ID.test(plan.ocrEvidence.inputVersionId) &&
      SHA256.test(plan.ocrEvidence.envelopeHash) && SHA256.test(plan.ocrEvidence.timeMapHash) &&
      Object.keys(plan.ocrEvidence).sort().join('|') === 'envelopeHash|envelopeId|inputVersionId|timeMapHash')),
  'INVALID_RENDER_INPUT', 'Subtitle anchor OCR evidence identity is invalid')
  const evidence = plan.faceClearance
  assertDomain(
    evidence?.schemaVersion === FACE_CLEARANCE_EVIDENCE_SCHEMA && evidence.faceSafety === 'unknown' &&
    evidence.meaning === FACE_CLEARANCE_MEANING && evidence.policySha256 === FACE_EVIDENCE_POLICY_SHA256 &&
    (evidence.projectionHash === null || SHA256.test(evidence.projectionHash)),
    'INVALID_RENDER_INPUT', 'Subtitle anchor face clearance evidence is invalid',
  )
  if (expected.projectionHash !== undefined) {
    assertDomain(evidence.projectionHash === expected.projectionHash, 'INVALID_RENDER_INPUT', 'Subtitle anchor plan is not bound to this render\'s caption projection')
  }
  const { evidenceHash, ...evidenceBody } = evidence
  assertDomain(SHA256.test(evidenceHash) && evidenceHash === calculateCanonicalHash(evidenceBody), 'INVALID_RENDER_INPUT', 'Subtitle anchor face clearance evidence hash is inconsistent')
  const streamIds = new Set<string>()
  for (const stream of evidence.streams) {
    const available = stream.streamHash !== null
    assertDomain(
      ID.test(stream.sourceArtifactId) && !streamIds.has(stream.sourceArtifactId) && stream.frameDomain === 'source' &&
      (available
        ? SHA256.test(stream.streamHash!) && typeof stream.sourceSha256 === 'string' && SHA256.test(stream.sourceSha256) &&
          stream.sourceFps !== null && Number.isSafeInteger(stream.sourceFps.num) && Number.isSafeInteger(stream.sourceFps.den) &&
          stream.sourceFps.num > 0 && stream.sourceFps.den > 0 && stream.unavailableReason === null
        : stream.sourceSha256 === null && stream.sourceFps === null && typeof stream.unavailableReason === 'string' &&
          stream.unavailableReason.length > 0 && stream.trustedEnvelopeHashes.length === 0 && stream.untrusted.length === 0) &&
      stream.trustedEnvelopeHashes.every((hash) => SHA256.test(hash)) &&
      stream.untrusted.every((item) => SHA256.test(item.envelopeHash) && Number.isSafeInteger(item.startSourceFrame) && Number.isSafeInteger(item.endSourceFrame)),
      'INVALID_RENDER_INPUT', 'Subtitle anchor face evidence stream identity is invalid',
    )
    streamIds.add(stream.sourceArtifactId)
  }
  const bands = deriveSubtitleAnchorBands({ region: expected.region, safeArea: expected.safeArea })
  assertDomain(calculateCanonicalHash(plan.bands) === calculateCanonicalHash(bands), 'INVALID_RENDER_INPUT', 'Subtitle anchor bands were not derived from this output preset')
  const policy = plan.policy
  assertDomain(
    Number.isSafeInteger(policy.minFramesBetweenChanges) && policy.minFramesBetweenChanges >= 0 &&
    (policy.onNoSafeRegion === 'suppress-cue' || policy.onNoSafeRegion === 'omit-and-list' || policy.onNoSafeRegion === 'fail-closed'),
    'INVALID_RENDER_INPUT', 'Subtitle anchor policy is invalid',
  )
  let previous: SubtitleAnchor | null = null
  let lastChangeFrame: number | null = null
  let lastCue: Readonly<SubtitleAnchorCueV1> | null = null
  const seen = new Set<string>()
  for (const recorded of plan.decisions) {
    assertDomain(!seen.has(recorded.cueId), 'INVALID_RENDER_INPUT', 'Subtitle anchor decisions must be unique per cue')
    seen.add(recorded.cueId)
    assertDomain(
      ID.test(recorded.cueId) && Number.isSafeInteger(recorded.startFrame) && Number.isSafeInteger(recorded.endFrame) &&
      recorded.startFrame >= 0 && recorded.endFrame > recorded.startFrame && recorded.endFrame <= plan.durationFrames,
      'INVALID_RENDER_INPUT', `Subtitle anchor decision ${recorded.cueId} is not a half-open interval inside the timeline`,
    )
    assertDomain(
      lastCue === null || recorded.startFrame > lastCue.startFrame || (recorded.startFrame === lastCue.startFrame && recorded.cueId.localeCompare(lastCue.id) > 0),
      'INVALID_RENDER_INPUT', 'Subtitle anchor decisions are not in cue order',
    )
    const cue: Readonly<SubtitleAnchorCueV1> = Object.freeze({ id: recorded.cueId, startFrame: recorded.startFrame, endFrame: recorded.endFrame })
    lastCue = cue
    const window = stabilityWindowOf(cue, plan.durationFrames, policy)
    assertDomain(
      recorded.stabilityWindow.startFrame === window.startFrame && recorded.stabilityWindow.endFrame === window.endFrame,
      'INVALID_RENDER_INPUT', `Subtitle anchor decision ${recorded.cueId} was not measured over its stability window`,
    )
    for (const anchor of SUBTITLE_ANCHOR_PREFERENCE) {
      const assessment = recorded.bandAssessments?.[anchor]
      assertDomain(assessment !== undefined && assessment !== null && typeof assessment === 'object' && assessment.face !== undefined,
        'INVALID_RENDER_INPUT', `Subtitle anchor decision ${recorded.cueId} misses the ${anchor} band assessment`)
      const face = assessment.face
      assertDomain(STATES.includes(face.state) && face.evaluations.length >= 1, 'INVALID_RENDER_INPUT', `Band ${anchor} of cue ${recorded.cueId} has no valid face clearance`)
      let cursor = window.startFrame
      for (const evaluation of face.evaluations) {
        assertDomain(
          BAND_EVALUATION_KINDS.includes(evaluation.kind) && STATES.includes(evaluation.state) &&
          evaluation.startFrame === cursor && evaluation.endFrame > evaluation.startFrame &&
          (evaluation.clearanceHash === null || SHA256.test(evaluation.clearanceHash)) &&
          (evaluation.kind === 'face-clearance' || evaluation.clearanceHash === null) &&
          (evaluation.kind === 'face-clearance'
            ? evaluation.sourceRange !== null && typeof evaluation.sourceRange === 'object' &&
              Number.isSafeInteger(evaluation.sourceRange.startFrame) && Number.isSafeInteger(evaluation.sourceRange.endFrame) &&
              evaluation.sourceRange.startFrame >= 0 &&
              evaluation.sourceRange.endFrame - evaluation.sourceRange.startFrame === evaluation.endFrame - evaluation.startFrame
            : evaluation.sourceRange === null) &&
          (evaluation.kind !== 'geometry-outside-foreground' || evaluation.state === 'free-certified') &&
          (evaluation.kind === 'geometry-outside-foreground' || evaluation.kind === 'face-clearance' || evaluation.state === 'unknown') &&
          (evaluation.sourceArtifactId === null || ID.test(evaluation.sourceArtifactId)),
          'INVALID_RENDER_INPUT', `Band ${anchor} of cue ${recorded.cueId} records an invalid clearance evaluation`,
        )
        cursor = evaluation.endFrame
      }
      assertDomain(
        cursor === window.endFrame && face.state === combineClearanceStates(face.evaluations.map((evaluation) => evaluation.state)) &&
        calculateCanonicalHash(face.reasons) === calculateCanonicalHash([...new Set(face.evaluations.flatMap((evaluation) => evaluation.reasons))].toSorted()),
        'INVALID_RENDER_INPUT', `Band ${anchor} of cue ${recorded.cueId} does not follow from its clearance evaluations`,
      )
      assertDomain(
        assessment.criticalBlockerIds.every((id) => assessment.blockerIds.includes(id)) &&
        assessment.blockerIds.every((id) => typeof id === 'string' && id.length > 0),
        'INVALID_RENDER_INPUT', `Band ${anchor} of cue ${recorded.cueId} records inconsistent blockers`,
      )
    }
    const derived: Readonly<{ decision: Readonly<SubtitleAnchorDecisionV3>; lastChangeFrame: number | null }> = deriveCueDecisionV3({
      cue, stabilityWindow: window, assessments: recorded.bandAssessments, bands, previous, lastChangeFrame, policy, fps: plan.fps,
    })
    assertDomain(
      calculateCanonicalHash(derived.decision) === calculateCanonicalHash(recorded),
      'INVALID_RENDER_INPUT', `Subtitle anchor decision ${recorded.cueId} does not follow from its band assessments`,
    )
    lastChangeFrame = derived.lastChangeFrame
    if (derived.decision.anchor !== null) previous = derived.decision.anchor
  }
  assertDomain(
    calculateCanonicalHash(plan.issues) === calculateCanonicalHash(sortedIssues(plan.decisions)),
    'INVALID_RENDER_INPUT', 'Subtitle anchor plan issues do not match its decisions',
  )
  const { anchorPlanHash, ...body } = plan
  assertDomain(SHA256.test(anchorPlanHash) && anchorPlanHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Subtitle anchor plan hash is inconsistent')
}
