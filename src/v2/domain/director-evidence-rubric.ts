import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  CONFIDENCE_BAND_POLICY_V2,
  CONFIDENCE_BAND_POLICY_V2_SHA256,
  EVIDENCE_TIERS,
  classifyConfidenceV2,
  type ConfidenceBand,
  type DecisionConfidence,
  type EvidenceGatedDecisionType,
  type EvidenceTier,
} from './decision-confidence.ts'
import { DomainError } from './errors.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256 } from './face-evidence-policy.ts'
import {
  PERCEPTION_KINDS,
  coveredMs,
  mergeRanges,
  type PerceptionKind,
  type PerceptionObservation,
  type PerceptionRange,
} from './perception-timeline.ts'
import type { ServerPerceptionSnapshot } from './server-perception-snapshot.ts'

/**
 * W64. The Director's evidence rubric: how it tells HIGH, PARTIAL and ABSENT evidence apart, per modality and per decision, from the
 * server perception snapshot of the Version it directs (W63a) and from the rights of the sources the plan plays.
 *
 * The tier is a property of the evidence, never of the planner's confidence in its choice:
 *
 * - `absent`: nothing was examined in the decision's range, or no producer ran, or the evidence is requested and still pending.
 * - `partial`: some of the range was examined, or all of it was but the evidence cannot be `high` (the modality has a ceiling, its
 *   confidence is not measured, or it is below the floor).
 * - `high`: the whole range is DENSELY covered (every instant of it within half the modality's density gap of an examined sample)
 *   by sealed evidence whose measured confidence is at or above the floor, in a modality whose ceiling allows `high`.
 *
 * `face` has a ceiling of `partial`: its boxes are `unverified-face-candidate` evidence of the V9 runtime, whose deployment gate
 * (`linux-parity-run-on-60-development-images-pending`) has not passed and whose policy claims no qualification. They are evidence,
 * never face-safe proof, so no amount of coverage lifts face above `partial`. The ceiling is read from `FACE_EVIDENCE_POLICY`, whose
 * hash is sealed here: the only way up is a new face policy and therefore a new rubric hash.
 *
 * Rights have no middle: `rights` is `high` when every source the decision touches has certain, current rights, and `absent`
 * otherwise (revoked, expired, unknown, consent not approved). There is no partial certainty.
 *
 * Every number below is a design prior (`parameterBasis`), the way the face evidence policy classifies its own: nothing here is
 * calibrated against labelled data (that is W63b), and changing one changes `DIRECTOR_EVIDENCE_RUBRIC_SHA256`.
 */
export type EvidenceModality = PerceptionKind | 'rights'
export const EVIDENCE_MODALITIES: readonly EvidenceModality[] = Object.freeze([...PERCEPTION_KINDS, 'rights'] as const)

export const FACE_DETECTOR_NOT_DEPLOYABLE = 'FACE_DETECTOR_NOT_DEPLOYABLE'
export const EVIDENCE_ID_CAP = 64

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

type ModalityRule = Readonly<{
  /** Every instant of a range must lie within half of this of an examined sample for the coverage to be dense. */
  maxGapMs: number
  /** Mean measured confidence a `high` tier needs. */
  confidenceFloor: number
  ceiling: 'high' | 'partial'
  ceilingReasonCode: string | null
  /** The snapshot input kind whose envelopes this modality is taken from. */
  inputKind: 'transcript' | 'ocr' | 'temporal' | 'face' | null
}>

const faceCeilingIsPartial = (FACE_EVIDENCE_POLICY.claims.qualification as boolean) !== true

export const DIRECTOR_EVIDENCE_RUBRIC = deepFreeze({
  schemaVersion: 'director-evidence-rubric/v1' as const,
  tiers: [...EVIDENCE_TIERS],
  modalities: {
    'transcript-word': { maxGapMs: 600, confidenceFloor: 0.7, ceiling: 'high', ceilingReasonCode: null, inputKind: 'transcript' },
    speaker: { maxGapMs: 0, confidenceFloor: 0.7, ceiling: 'high', ceilingReasonCode: null, inputKind: null },
    silence: { maxGapMs: 0, confidenceFloor: 0.7, ceiling: 'high', ceilingReasonCode: null, inputKind: null },
    face: {
      maxGapMs: FACE_EVIDENCE_POLICY.clearance.maxSampleGapMs,
      confidenceFloor: FACE_EVIDENCE_POLICY.evidence.scoreMin,
      ceiling: faceCeilingIsPartial ? 'partial' : 'high',
      ceilingReasonCode: faceCeilingIsPartial ? FACE_DETECTOR_NOT_DEPLOYABLE : null,
      inputKind: 'face',
    },
    object: { maxGapMs: 0, confidenceFloor: 0.7, ceiling: 'high', ceilingReasonCode: null, inputKind: null },
    shot: { maxGapMs: 0, confidenceFloor: 0, ceiling: 'high', ceilingReasonCode: null, inputKind: 'temporal' },
    motion: { maxGapMs: 0, confidenceFloor: 0, ceiling: 'high', ceilingReasonCode: null, inputKind: 'temporal' },
    ocr: { maxGapMs: 2000, confidenceFloor: 0.6, ceiling: 'high', ceilingReasonCode: null, inputKind: 'ocr' },
    'image-insert': { maxGapMs: 0, confidenceFloor: 0.7, ceiling: 'high', ceilingReasonCode: null, inputKind: null },
  } satisfies Record<PerceptionKind, ModalityRule>,
  rights: { integral: true as const, partialExists: false as const },
  /** What each evidence-gated decision type stands on. The Director cannot weaken this: the rubric, not the planner, names it. */
  requirements: {
    crop: { always: ['face'] },
    caption: { always: ['transcript-word', 'face', 'ocr'] },
    insert: { whenInserted: ['rights'], whenOmitted: [] },
  } as Record<EvidenceGatedDecisionType, Readonly<{ always?: readonly EvidenceModality[]; whenInserted?: readonly EvidenceModality[]; whenOmitted?: readonly EvidenceModality[] }>>,
  faceEvidencePolicySha256: FACE_EVIDENCE_POLICY_SHA256,
  faceDeploymentGate: FACE_EVIDENCE_POLICY.claims.deploymentGate,
  parameterBasis: {
    'modalities.*.maxGapMs': 'design-prior-unmeasured (face: the clearance gap of the face evidence policy; transcript: the Director\'s own 0.55 s caption grouping, rounded up)',
    'modalities.*.confidenceFloor': 'design-prior-unmeasured (face: the owner-accepted V9 score floor; transcript: the transcription review floor)',
    'modalities.face.ceiling': 'owner-rule: V9 boxes are unverified-face-candidate evidence until the deployment gate passes',
    'requirements': 'coordinator-decision (W64): crop stands on faces, a caption on its words, faces and burned-in text, an insert on certain rights',
  },
})
export const DIRECTOR_EVIDENCE_RUBRIC_SHA256: string = calculateCanonicalHash(DIRECTOR_EVIDENCE_RUBRIC)
export type DirectorEvidenceRubric = typeof DIRECTOR_EVIDENCE_RUBRIC

export function requiredModalitiesFor(type: EvidenceGatedDecisionType, inserted: boolean): readonly EvidenceModality[] {
  const rule = DIRECTOR_EVIDENCE_RUBRIC.requirements[type]
  return Object.freeze([...(rule.always ?? []), ...(inserted ? rule.whenInserted ?? [] : rule.whenOmitted ?? [])])
}

export type SourceRightsRecord = Readonly<
  | { state: 'missing' }
  | {
      state: 'present'
      snapshotId: string
      snapshotHash: string
      status: string
      consentStatus: string
      expiresAt?: string
      consentExpiresAt?: string
    }
>

export type SourceRightsVerdict = Readonly<{
  artifactId: string
  certain: boolean
  reasonCode: string
  snapshotId: string | null
  snapshotHash: string | null
}>

/**
 * Whether the rights of one source are CERTAIN at `now`: approved, with consent approved or not required, neither expiring at or
 * before `now`. Missing rights are unknown, not "fine"; there is no partial certainty.
 */
export function evaluateSourceRightsCertainty(artifactId: string, rights: SourceRightsRecord | undefined, now: Date): SourceRightsVerdict {
  if (rights === undefined || rights.state === 'missing') {
    return Object.freeze({ artifactId, certain: false, reasonCode: 'RIGHTS_UNKNOWN', snapshotId: null, snapshotHash: null })
  }
  const base = { artifactId, snapshotId: rights.snapshotId, snapshotHash: rights.snapshotHash }
  const expired = (value: string | undefined) => value !== undefined &&
    (Number.isNaN(new Date(value).getTime()) || new Date(value).getTime() <= now.getTime())
  const upper = (value: string) => value.toUpperCase().replaceAll('-', '_')
  const reasonCode = rights.status !== 'approved' ? `RIGHTS_STATUS_${upper(rights.status)}`
    : !['approved', 'not-required'].includes(rights.consentStatus) ? `CONSENT_STATUS_${upper(rights.consentStatus)}`
      : expired(rights.expiresAt) ? 'RIGHTS_EXPIRED'
        : expired(rights.consentExpiresAt) ? 'CONSENT_EXPIRED'
          : 'RIGHTS_CERTAIN'
  return Object.freeze({ ...base, certain: reasonCode === 'RIGHTS_CERTAIN', reasonCode })
}

/** Face evidence the Director asked for and does not hold yet: the timeline ranges (ms) of the windows requested, or whose request failed. */
export type FaceEvidenceRequestState = Readonly<{
  pendingRangesMs: readonly PerceptionRange[]
  failedRangesMs: readonly PerceptionRange[]
}>
export const NO_FACE_EVIDENCE_REQUESTS: FaceEvidenceRequestState = Object.freeze({
  pendingRangesMs: Object.freeze([]), failedRangesMs: Object.freeze([]),
})

export type ModalityAssessment = Readonly<{
  modality: EvidenceModality
  tier: EvidenceTier
  reasonCode: string
  /** Length of the ranges assessed. */
  rangeMs: number
  /** Milliseconds of them a sealed producer examined (its samples, as the snapshot's coverage states them). */
  examinedMs: number
  /** Milliseconds of them within half the density gap of an examined sample. */
  denseMs: number
  /** Milliseconds of them whose evidence is requested and not sealed yet (face only). */
  pendingMs: number
  /** Mean of the MEASURED confidences of the observations in the ranges; null when none is measured. */
  confidence: number | null
  confidenceBasis: 'producer-reported' | 'deterministic-measurement' | 'policy-prior' | 'none'
  /** True when the modality's ceiling, not the evidence, is what keeps the tier below `high`. */
  ceilingApplied: boolean
  /** The sealed envelopes the snapshot took this modality from (sorted, at most EVIDENCE_ID_CAP of them). */
  envelopeIds: readonly string[]
  envelopeCount: number
  /** The observations in the ranges (timeline order, at most EVIDENCE_ID_CAP of them); the count and the hash cover all of them. */
  observationIds: readonly string[]
  observationCount: number
  observationIdsHash: string
}>

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

function intersectRanges(left: readonly PerceptionRange[], right: readonly PerceptionRange[]): readonly PerceptionRange[] {
  const result: PerceptionRange[] = []
  for (const a of left) for (const b of right) {
    const start = Math.max(a[0], b[0]), end = Math.min(a[1], b[1])
    if (end > start) result.push(Object.freeze([start, end] as const))
  }
  return mergeRanges(result)
}

function normalizedRanges(rangesMs: readonly PerceptionRange[], durationMs: number): readonly PerceptionRange[] {
  const clean = rangesMs.map((range) => {
    if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) ||
        range[0] < 0 || range[1] > durationMs || range[1] <= range[0]) {
      throw new DomainError('INVALID_ARGUMENT', 'A decision evidence range lies outside the timeline')
    }
    return range
  })
  if (clean.length === 0) throw new DomainError('INVALID_ARGUMENT', 'A decision evidence range is required')
  return mergeRanges(clean)
}

/** The ranges within half of `gapMs` of an examined sample: what the samples can speak for, and no more. */
function dilate(examined: readonly PerceptionRange[], gapMs: number): readonly PerceptionRange[] {
  const half = gapMs / 2
  return mergeRanges(examined.map((range) => Object.freeze([Math.floor(range[0] - half), Math.ceil(range[1] + half)] as const)))
}

function idsOf(observations: readonly Readonly<PerceptionObservation>[]) {
  const ids = observations.toSorted((left, right) => left.startMs - right.startMs || compareText(left.id, right.id)).map((item) => item.id)
  return { all: ids, listed: Object.freeze(ids.slice(0, EVIDENCE_ID_CAP)), hash: calculateCanonicalHash(ids) }
}

const BASIS_RANK = { 'producer-reported': 2, 'deterministic-measurement': 1 } as const

/**
 * How well the snapshot examined `rangesMs` for one perception kind. A pure function of the snapshot, the ranges and the face-request
 * state: the same inputs give the same assessment, byte for byte.
 */
export function assessPerceptionModality(
  snapshot: Pick<ServerPerceptionSnapshot, 'timeline' | 'inputs'>,
  kind: PerceptionKind,
  rangesMs: readonly PerceptionRange[],
  faceRequests: FaceEvidenceRequestState = NO_FACE_EVIDENCE_REQUESTS,
): ModalityAssessment {
  const rule: ModalityRule = DIRECTOR_EVIDENCE_RUBRIC.modalities[kind]
  const { timeline } = snapshot
  const ranges = normalizedRanges(rangesMs, timeline.durationMs)
  const rangeMs = coveredMs(ranges)
  const coverage = timeline.coverage.find((entry) => entry.kind === kind)
  if (!coverage) throw new DomainError('PERSISTENCE_CONFLICT', 'The snapshot timeline does not state coverage for every kind')
  const examined = intersectRanges(ranges, coverage.ranges)
  const examinedMs = coveredMs(examined)
  const denseMs = coveredMs(intersectRanges(ranges, dilate(coverage.ranges, rule.maxGapMs)))
  const inRange = timeline.observations.filter((item) => item.kind === kind &&
    ranges.some((range) => item.startMs < range[1] && item.endMs > range[0]))
  const measured = inRange.filter((item) => item.provenance.confidenceBasis === 'producer-reported' ||
    item.provenance.confidenceBasis === 'deterministic-measurement')
  const confidence = measured.length === 0 ? null
    : Number((measured.reduce((sum, item) => sum + item.provenance.confidence, 0) / measured.length).toFixed(6))
  const confidenceBasis = measured.length > 0
    ? (measured.some((item) => BASIS_RANK[item.provenance.confidenceBasis as keyof typeof BASIS_RANK] === 2) ? 'producer-reported' as const : 'deterministic-measurement' as const)
    : inRange.length > 0 ? 'policy-prior' as const : 'none' as const
  const pendingMs = kind === 'face' ? coveredMs(intersectRanges(ranges, mergeRanges(faceRequests.pendingRangesMs))) : 0
  const failedMs = kind === 'face' ? coveredMs(intersectRanges(ranges, mergeRanges(faceRequests.failedRangesMs))) : 0

  let tier: EvidenceTier
  let reasonCode: string
  let ceilingApplied = false
  if (examinedMs === 0) {
    tier = 'absent'
    reasonCode = pendingMs > 0 ? 'FACE_EVIDENCE_PENDING'
      : failedMs > 0 ? 'FACE_EVIDENCE_REQUEST_FAILED'
        : coverage.reasonCode ?? 'NOT_EXAMINED_IN_RANGE'
  } else if (denseMs < rangeMs) {
    tier = 'partial'
    reasonCode = pendingMs > 0 ? 'PARTIAL_COVERAGE_REST_PENDING' : 'PARTIAL_COVERAGE'
  } else if (rule.ceiling === 'partial') {
    tier = 'partial'
    reasonCode = rule.ceilingReasonCode ?? 'MODALITY_CEILING'
    ceilingApplied = true
  } else if (inRange.length > 0 && measured.length === 0) {
    tier = 'partial'
    reasonCode = 'CONFIDENCE_NOT_MEASURED'
  } else if (confidence !== null && confidence < rule.confidenceFloor) {
    tier = 'partial'
    reasonCode = 'BELOW_CONFIDENCE_FLOOR'
  } else {
    tier = 'high'
    reasonCode = 'SEALED_DENSE_COVERAGE'
  }

  const inputs = rule.inputKind === null ? [] : snapshot.inputs.filter((input) => input.kind === rule.inputKind)
    .map((input) => input.envelopeId).toSorted(compareText)
  const observations = idsOf(inRange)
  return Object.freeze({
    modality: kind, tier, reasonCode, rangeMs, examinedMs, denseMs, pendingMs, confidence, confidenceBasis, ceilingApplied,
    envelopeIds: Object.freeze(inputs.slice(0, EVIDENCE_ID_CAP)), envelopeCount: inputs.length,
    observationIds: observations.listed, observationCount: observations.all.length, observationIdsHash: observations.hash,
  })
}

/** Rights as a modality: `high` when every source the decision touches is certain, `absent` otherwise. */
export function assessRightsModality(verdicts: readonly SourceRightsVerdict[], rangeMs: number): ModalityAssessment {
  const refused = verdicts.find((verdict) => !verdict.certain)
  const ids = verdicts.map((verdict) => verdict.snapshotId).filter((id): id is string => id !== null).toSorted(compareText)
  const certain = verdicts.length > 0 && refused === undefined
  return Object.freeze({
    modality: 'rights' as const,
    tier: certain ? 'high' as const : 'absent' as const,
    reasonCode: certain ? 'RIGHTS_CERTAIN' : verdicts.length === 0 ? 'RIGHTS_UNKNOWN' : refused!.reasonCode,
    rangeMs, examinedMs: certain ? rangeMs : 0, denseMs: certain ? rangeMs : 0, pendingMs: 0,
    confidence: null, confidenceBasis: 'none' as const, ceilingApplied: false,
    envelopeIds: Object.freeze(ids.slice(0, EVIDENCE_ID_CAP)), envelopeCount: ids.length,
    observationIds: Object.freeze([]), observationCount: 0, observationIdsHash: calculateCanonicalHash([]),
  })
}

export function weakestTier(tiers: readonly EvidenceTier[]): EvidenceTier {
  if (tiers.includes('absent')) return 'absent'
  if (tiers.includes('partial')) return 'partial'
  return 'high'
}

export type DecisionPerceptionEvidence = Readonly<{
  schemaVersion: 'decision-perception-evidence/v1'
  decisionId: string
  decisionType: EvidenceGatedDecisionType
  snapshot: Readonly<{ id: string; snapshotHash: string }>
  rangesMs: readonly PerceptionRange[]
  required: readonly EvidenceModality[]
  /** The weakest tier of the required modalities; `high` only when there is nothing to stand on (an omitted insert) or all are high. */
  tier: EvidenceTier
  modalities: readonly ModalityAssessment[]
  rubricHash: string
  evidenceHash: string
}>

function sealDecisionEvidence(body: Omit<DecisionPerceptionEvidence, 'evidenceHash'>): DecisionPerceptionEvidence {
  return Object.freeze({ ...body, evidenceHash: calculateCanonicalHash(body) })
}

/**
 * The evidence one crop, caption or insert decision stands on: the rubric names the modalities its type requires, each is assessed over
 * the decision's own ranges, and the decision's tier is the weakest of them. Rights are looked up per source the decision touches.
 */
export function assessDecisionEvidence(input: Readonly<{
  decisionId: string
  decisionType: EvidenceGatedDecisionType
  snapshot: Pick<ServerPerceptionSnapshot, 'timeline' | 'inputs' | 'snapshotHash'>
  snapshotId: string
  rangesMs: readonly PerceptionRange[]
  /** Whether the decision proposes footage beyond the master (an insert); decides which requirement of its type applies. */
  inserted?: boolean
  /** Verdicts for the sources the decision touches (an insert's sources); read when `rights` is required. */
  rights?: readonly SourceRightsVerdict[]
  faceRequests?: FaceEvidenceRequestState
}>): DecisionPerceptionEvidence {
  const ranges = normalizedRanges(input.rangesMs, input.snapshot.timeline.durationMs)
  const required = requiredModalitiesFor(input.decisionType, input.inserted === true)
  const modalities = required.map((modality) => modality === 'rights'
    ? assessRightsModality(input.rights ?? [], coveredMs(ranges))
    : assessPerceptionModality(input.snapshot, modality, ranges, input.faceRequests))
  return sealDecisionEvidence({
    schemaVersion: 'decision-perception-evidence/v1',
    decisionId: input.decisionId,
    decisionType: input.decisionType,
    snapshot: Object.freeze({ id: input.snapshotId, snapshotHash: input.snapshot.snapshotHash }),
    rangesMs: ranges,
    required: Object.freeze([...required]),
    tier: modalities.length === 0 ? 'high' : weakestTier(modalities.map((item) => item.tier)),
    modalities: Object.freeze(modalities),
    rubricHash: DIRECTOR_EVIDENCE_RUBRIC_SHA256,
  })
}

/**
 * The band an evidence-gated decision gets: `confidence-band-policy/v2` over (tier, confidence). The tier is the evidence's, not the
 * decision's; a decision whose evidence is `absent` is never `auto-apply`.
 */
export function bandOfDecisionEvidence(
  evidence: Pick<DecisionPerceptionEvidence, 'decisionType' | 'tier'>,
  confidence: Readonly<DecisionConfidence>,
): ConfidenceBand {
  return classifyConfidenceV2(evidence.decisionType, confidence, evidence.tier)
}

export const DECISION_BAND_POLICY_REF = Object.freeze({
  schemaVersion: CONFIDENCE_BAND_POLICY_V2.schemaVersion,
  policyHash: CONFIDENCE_BAND_POLICY_V2_SHA256,
})

const HASH = /^[a-f0-9]{64}$/
const MODALITY_REASON = /^[A-Z][A-Z0-9_]{2,63}$/

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function parseModality(value: unknown): ModalityAssessment {
  const item = recordOf(value, 'modality assessment')
  const keys = ['modality', 'tier', 'reasonCode', 'rangeMs', 'examinedMs', 'denseMs', 'pendingMs', 'confidence', 'confidenceBasis',
    'ceilingApplied', 'envelopeIds', 'envelopeCount', 'observationIds', 'observationCount', 'observationIdsHash']
  const integer = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0
  if (Object.keys(item).sort().join('|') !== [...keys].sort().join('|') ||
      !(EVIDENCE_MODALITIES as readonly unknown[]).includes(item.modality) ||
      !(EVIDENCE_TIERS as readonly unknown[]).includes(item.tier) ||
      typeof item.reasonCode !== 'string' || !MODALITY_REASON.test(item.reasonCode) ||
      !integer(item.rangeMs) || !integer(item.examinedMs) || !integer(item.denseMs) || !integer(item.pendingMs) ||
      (item.examinedMs as number) > (item.rangeMs as number) || (item.denseMs as number) > (item.rangeMs as number) ||
      (item.denseMs as number) < (item.examinedMs as number) ||
      !(item.confidence === null || (typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1)) ||
      !['producer-reported', 'deterministic-measurement', 'policy-prior', 'none'].includes(String(item.confidenceBasis)) ||
      typeof item.ceilingApplied !== 'boolean' ||
      !Array.isArray(item.envelopeIds) || item.envelopeIds.length > EVIDENCE_ID_CAP ||
      item.envelopeIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128) ||
      !integer(item.envelopeCount) || (item.envelopeCount as number) < item.envelopeIds.length ||
      !Array.isArray(item.observationIds) || item.observationIds.length > EVIDENCE_ID_CAP ||
      item.observationIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128) ||
      !integer(item.observationCount) || (item.observationCount as number) < item.observationIds.length ||
      typeof item.observationIdsHash !== 'string' || !HASH.test(item.observationIdsHash)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored modality assessment is invalid')
  }
  // The tier is what the rubric says of the figures it was derived from: a stored tier that contradicts them is not trusted.
  const absent = item.examinedMs === 0
  if ((item.tier === 'absent') !== absent ||
      (item.tier === 'high' && ((item.denseMs as number) < (item.rangeMs as number) || item.ceilingApplied === true)) ||
      (item.modality === 'face' && item.tier === 'high' && DIRECTOR_EVIDENCE_RUBRIC.modalities.face.ceiling === 'partial') ||
      (item.modality === 'rights' && item.tier === 'partial')) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored modality tier contradicts its own figures')
  }
  return Object.freeze({ ...item, envelopeIds: Object.freeze([...item.envelopeIds as string[]]),
    observationIds: Object.freeze([...item.observationIds as string[]]) }) as unknown as ModalityAssessment
}

/**
 * Re-reads a stored decision evidence record: its seal, its policy, its tier (the weakest of its modalities), and that its band, when
 * asked for, is what `confidence-band-policy/v2` makes of (tier, confidence). It cannot re-derive the figures: for that, hand the
 * record and the stored snapshot to `verifyDecisionEvidenceAgainstSnapshot`.
 */
export function parseDecisionPerceptionEvidence(value: unknown): DecisionPerceptionEvidence {
  const item = recordOf(value, 'decision perception evidence')
  const keys = ['schemaVersion', 'decisionId', 'decisionType', 'snapshot', 'rangesMs', 'required', 'tier', 'modalities', 'rubricHash', 'evidenceHash']
  if (Object.keys(item).sort().join('|') !== [...keys].sort().join('|') ||
      item.schemaVersion !== 'decision-perception-evidence/v1' ||
      typeof item.decisionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(item.decisionId) ||
      !['crop', 'caption', 'insert'].includes(String(item.decisionType)) ||
      typeof item.rubricHash !== 'string' || item.rubricHash !== DIRECTOR_EVIDENCE_RUBRIC_SHA256 ||
      !(EVIDENCE_TIERS as readonly unknown[]).includes(item.tier) ||
      !Array.isArray(item.modalities) || item.modalities.length > 16 ||
      !Array.isArray(item.required) || item.required.some((modality) => !(EVIDENCE_MODALITIES as readonly unknown[]).includes(modality)) ||
      !Array.isArray(item.rangesMs) || item.rangesMs.length < 1 || item.rangesMs.length > 256 ||
      item.rangesMs.some((range) => !Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) ||
        !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] <= range[0])) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored decision perception evidence is invalid')
  }
  const snapshot = recordOf(item.snapshot, 'decision perception evidence snapshot')
  if (Object.keys(snapshot).sort().join('|') !== 'id|snapshotHash' || typeof snapshot.id !== 'string' ||
      typeof snapshot.snapshotHash !== 'string' || !HASH.test(snapshot.snapshotHash) ||
      snapshot.id !== `perception-snapshot-${snapshot.snapshotHash.slice(0, 40)}`) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored decision perception evidence names an invalid snapshot')
  }
  const modalities = (item.modalities as unknown[]).map(parseModality)
  const expectedTier = modalities.length === 0 ? 'high' : weakestTier(modalities.map((entry) => entry.tier))
  const required = item.required as EvidenceModality[]
  // The rubric, not the record, says what a decision type stands on: a record that sealed itself with fewer requirements (a crop that
  // requires nothing is `high`) is refused whatever its seal. An insert may stand on nothing only when it proposes nothing; the decision
  // that carries the record checks which of the two it is (`validateDirectorDecisions`).
  const legal = [requiredModalitiesFor(item.decisionType as EvidenceGatedDecisionType, false), requiredModalitiesFor(item.decisionType as EvidenceGatedDecisionType, true)]
  if (!legal.some((expected) => expected.length === required.length && expected.every((modality, index) => modality === required[index]))) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored decision perception evidence does not require what the rubric demands of its decision type')
  }
  if (item.tier !== expectedTier || modalities.length !== required.length ||
      modalities.some((entry, index) => entry.modality !== required[index])) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored decision perception evidence tier or modalities are inconsistent')
  }
  const { evidenceHash, ...body } = item as Record<string, unknown>
  if (typeof evidenceHash !== 'string' || calculateCanonicalHash(body) !== evidenceHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored decision perception evidence hash is invalid')
  }
  return Object.freeze({ ...item, snapshot: Object.freeze({ ...snapshot }), modalities: Object.freeze(modalities),
    required: Object.freeze([...required]), rangesMs: Object.freeze((item.rangesMs as number[][]).map((range) => Object.freeze([range[0]!, range[1]!] as const))) }) as unknown as DecisionPerceptionEvidence
}

/**
 * The oracle: the stored evidence of a decision, re-derived from the stored snapshot it names (and the same rights and face-request
 * inputs), must be byte-identical. A tier, a figure or an evidence id the snapshot does not support fails here.
 */
export function verifyDecisionEvidenceAgainstSnapshot(
  evidence: DecisionPerceptionEvidence,
  snapshot: Pick<ServerPerceptionSnapshot, 'timeline' | 'inputs' | 'snapshotHash'>,
  context: Readonly<{ snapshotId: string; inserted?: boolean; rights?: readonly SourceRightsVerdict[]; faceRequests?: FaceEvidenceRequestState }>,
): void {
  const rebuilt = assessDecisionEvidence({
    decisionId: evidence.decisionId, decisionType: evidence.decisionType, snapshot, snapshotId: context.snapshotId,
    rangesMs: evidence.rangesMs, inserted: context.inserted === true, ...(context.rights ? { rights: context.rights } : {}),
    ...(context.faceRequests ? { faceRequests: context.faceRequests } : {}),
  })
  if (rebuilt.evidenceHash !== evidence.evidenceHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Decision perception evidence is not what its snapshot supports')
  }
}
