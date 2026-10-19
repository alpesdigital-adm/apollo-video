import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export const CONFIDENCE_DECISION_TYPES = Object.freeze([
  'transcription', 'cut', 'asset-selection', 'narrative-reorder', 'rights', 'generation',
] as const)
export type ConfidenceDecisionType = (typeof CONFIDENCE_DECISION_TYPES)[number]
export type ConfidenceBand = 'auto-apply' | 'review' | 'block'

export interface DecisionConfidence {
  schemaVersion: 'decision-confidence/v1'
  value: number
  evidence: readonly Readonly<{ ref: string; weight: number }>[]
  reasonCodes: readonly string[]
  calibrationVersion: string
  confidenceHash: string
}

export const CONFIDENCE_BAND_POLICY = Object.freeze({
  schemaVersion: 'confidence-band-policy/v1' as const,
  transcription: Object.freeze({ autoApply: 0.92, review: 0.7 }),
  cut: Object.freeze({ autoApply: 0.88, review: 0.65 }),
  'asset-selection': Object.freeze({ autoApply: 0.85, review: 0.6 }),
  'narrative-reorder': Object.freeze({ autoApply: 0.9, review: 0.75 }),
  rights: Object.freeze({ autoApply: 1, review: 1 }),
  generation: Object.freeze({ autoApply: 0.86, review: 0.62 }),
})

/**
 * W64. How much of what a decision stands on was actually examined, per the Director's evidence rubric
 * (`director-evidence-rubric.ts`): `high` is complete (dense) sealed coverage from a producer whose confidence is measured and at or
 * above the floor, `partial` is some of the range examined or evidence below what `high` needs, `absent` is nothing examined. The tier
 * is a property of the evidence, never of the planner's own confidence in its choice.
 */
export const EVIDENCE_TIERS = Object.freeze(['high', 'partial', 'absent'] as const)
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number]

/** The decision types `confidence-band-policy/v2` adds: each stands on perception, so its band is a function of (tier, confidence). */
export const EVIDENCE_GATED_DECISION_TYPES = Object.freeze(['crop', 'caption', 'insert'] as const)
export type EvidenceGatedDecisionType = (typeof EVIDENCE_GATED_DECISION_TYPES)[number]
export type ConfidenceDecisionTypeV2 = ConfidenceDecisionType | EvidenceGatedDecisionType

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * `confidence-band-policy/v2` (W64). The v1 types keep exactly their v1 thresholds (a run born under v1 stays graded by
 * `CONFIDENCE_BAND_POLICY`; this policy never re-grades it). `crop`, `caption` and `insert` are evidence-gated:
 *
 * - `block` when the confidence is below `review`: the decision stands on less than the type tolerates;
 * - `onAbsent` when nothing was examined (tier `absent`) and the confidence is at least `review`: never `auto-apply`. The two
 *   evidence-gated types that propose a reviewable DRAFT (`crop`: the Director's only crop is the non-destructive 16:9 inset on a
 *   blurred source; `caption`: the reserved bottom region) answer `review`, because a human can still inspect and correct them and
 *   blocking would stop every run whose face detector has not looked yet. `insert` answers `block`: an insert adds footage the owner's
 *   master does not hold, and without certain rights nothing may stand on it;
 * - `auto-apply` only for tier `high` with a confidence of at least `autoApply`; any other tier at or above `review` is `review`.
 *
 * `rights` stays integral (1/1) and ignores the tier: certainty, or block. Every threshold is a design prior; no labelled corpus (W63b)
 * exists to calibrate them, and changing one changes `CONFIDENCE_BAND_POLICY_V2_SHA256`.
 */
export const CONFIDENCE_BAND_POLICY_V2 = deepFreeze({
  schemaVersion: 'confidence-band-policy/v2' as const,
  transcription: { autoApply: 0.92, review: 0.7 },
  cut: { autoApply: 0.88, review: 0.65 },
  'asset-selection': { autoApply: 0.85, review: 0.6 },
  'narrative-reorder': { autoApply: 0.9, review: 0.75 },
  rights: { autoApply: 1, review: 1 },
  generation: { autoApply: 0.86, review: 0.62 },
  crop: { autoApply: 0.8, review: 0.62, onAbsent: 'review' as const },
  caption: { autoApply: 0.8, review: 0.7, onAbsent: 'review' as const },
  insert: { autoApply: 0.9, review: 0.65, onAbsent: 'block' as const },
  parameterBasis: {
    'crop|caption|insert.autoApply': 'design-prior-unmeasured',
    'crop|caption|insert.review': 'design-prior-unmeasured (crop = generation floor, caption = transcription floor)',
    'crop|caption|insert.onAbsent': 'owner-rule: absent evidence is never auto-apply; draft types review, insert blocks',
    'v1 types': 'unchanged from confidence-band-policy/v1',
  },
})
export type ConfidenceBandPolicyV2 = typeof CONFIDENCE_BAND_POLICY_V2
export const CONFIDENCE_BAND_POLICY_V2_SHA256: string = calculateCanonicalHash(CONFIDENCE_BAND_POLICY_V2)
export const CONFIDENCE_BAND_POLICY_V1_SHA256: string = calculateCanonicalHash(CONFIDENCE_BAND_POLICY)

/** Which policy graded a decision. Absent on a decision born before W64: such a decision is graded by v1, exactly as it was. */
export type DecisionBandPolicyRef = Readonly<
  | { schemaVersion: 'confidence-band-policy/v2'; policyHash: string }
>

export function isEvidenceGatedType(type: string): type is EvidenceGatedDecisionType {
  return (EVIDENCE_GATED_DECISION_TYPES as readonly string[]).includes(type)
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/

export function createDecisionConfidence(input: {
  value: number
  evidence: readonly Readonly<{ ref: string; weight: number }>[]
  reasonCodes: readonly string[]
  calibrationVersion: string
}): Readonly<DecisionConfidence> {
  if (!Number.isFinite(input.value) || input.value < 0 || input.value > 1) {
    throw new DomainError('INVALID_ARGUMENT', 'Decision confidence value must be between zero and one')
  }
  if (input.evidence.length < 1 || input.evidence.length > 32) {
    throw new DomainError('INVALID_ARGUMENT', 'Decision confidence requires bounded evidence')
  }
  const refs = new Set<string>()
  const evidence = Object.freeze(input.evidence.map((item) => {
    const ref = item.ref?.trim()
    if (!REF.test(ref) || refs.has(ref) || !Number.isFinite(item.weight) || item.weight <= 0 || item.weight > 1) {
      throw new DomainError('INVALID_ARGUMENT', 'Decision confidence evidence is invalid')
    }
    refs.add(ref)
    return Object.freeze({ ref, weight: item.weight })
  }))
  const weight = evidence.reduce((sum, item) => sum + item.weight, 0)
  if (Math.abs(weight - 1) > 1e-9) {
    throw new DomainError('INVALID_ARGUMENT', 'Decision confidence evidence weights must sum to one')
  }
  const reasonCodes = Object.freeze(input.reasonCodes.map((value) => value?.trim()))
  if (
    reasonCodes.length < 1 || reasonCodes.length > 16 ||
    new Set(reasonCodes).size !== reasonCodes.length || reasonCodes.some((value) => !REASON.test(value))
  ) throw new DomainError('INVALID_ARGUMENT', 'Decision confidence reason codes are invalid')
  const calibrationVersion = input.calibrationVersion?.trim()
  if (!VERSION.test(calibrationVersion)) {
    throw new DomainError('INVALID_ARGUMENT', 'Decision confidence calibration version is invalid')
  }
  const body = Object.freeze({
    schemaVersion: 'decision-confidence/v1' as const,
    value: input.value,
    evidence,
    reasonCodes,
    calibrationVersion,
  })
  return Object.freeze({ ...body, confidenceHash: calculateCanonicalHash(body) })
}

export function classifyConfidence(
  type: ConfidenceDecisionType,
  confidence: Readonly<DecisionConfidence>,
): ConfidenceBand {
  const canonical = createDecisionConfidence(confidence)
  if (canonical.confidenceHash !== confidence.confidenceHash) {
    throw new DomainError('INVALID_ARGUMENT', 'Decision confidence hash is invalid')
  }
  const threshold = CONFIDENCE_BAND_POLICY[type]
  if (!threshold) throw new DomainError('INVALID_ARGUMENT', 'Decision confidence type is invalid')
  if (type === 'rights') return canonical.value === 1 ? 'auto-apply' : 'block'
  return canonical.value >= threshold.autoApply
    ? 'auto-apply'
    : canonical.value >= threshold.review ? 'review' : 'block'
}

/**
 * The band `confidence-band-policy/v2` gives a decision. The evidence-gated types (`crop`, `caption`, `insert`) need the tier of the
 * evidence they stand on and refuse to be graded without it: a missing tier is a bug of the caller, never "high". Every other type
 * is graded exactly as v1 grades it (the tier is ignored), and `rights` is integral.
 */
export function classifyConfidenceV2(
  type: ConfidenceDecisionTypeV2,
  confidence: Readonly<DecisionConfidence>,
  tier?: EvidenceTier,
): ConfidenceBand {
  const canonical = createDecisionConfidence(confidence)
  if (canonical.confidenceHash !== confidence.confidenceHash) {
    throw new DomainError('INVALID_ARGUMENT', 'Decision confidence hash is invalid')
  }
  if (type === 'rights') return canonical.value === 1 ? 'auto-apply' : 'block'
  if (!isEvidenceGatedType(type)) {
    const threshold = CONFIDENCE_BAND_POLICY_V2[type as ConfidenceDecisionType]
    if (!threshold) throw new DomainError('INVALID_ARGUMENT', 'Decision confidence type is invalid')
    return canonical.value >= threshold.autoApply
      ? 'auto-apply'
      : canonical.value >= threshold.review ? 'review' : 'block'
  }
  if (tier === undefined || !(EVIDENCE_TIERS as readonly string[]).includes(tier)) {
    throw new DomainError('INVALID_ARGUMENT', 'An evidence-gated decision needs the tier of its evidence')
  }
  const rule = CONFIDENCE_BAND_POLICY_V2[type]
  if (canonical.value < rule.review) return 'block'
  if (tier === 'absent') return rule.onAbsent
  return tier === 'high' && canonical.value >= rule.autoApply ? 'auto-apply' : 'review'
}

export function relevantUncertainty(items: readonly Readonly<{
  id: string
  label: string
  type: ConfidenceDecisionType
  confidence: Readonly<DecisionConfidence>
}>[]) {
  return Object.freeze(items.map((item) => Object.freeze({
    ...item,
    band: classifyConfidence(item.type, item.confidence),
  })).filter((item) => item.band !== 'auto-apply').toSorted((left, right) =>
    left.confidence.value - right.confidence.value || left.id.localeCompare(right.id)))
}

export interface CalibrationSample {
  id: string
  predicted: number
  correct: boolean
}

export function expectedCalibrationError(
  samples: readonly Readonly<Pick<CalibrationSample, 'predicted' | 'correct'>>[],
  bins = 10,
): number {
  if (!Number.isSafeInteger(bins) || bins < 2 || bins > 100 || samples.length < 1) {
    throw new DomainError('INVALID_ARGUMENT', 'Calibration evaluation requires samples and bounded bins')
  }
  if (samples.some((sample) =>
    !Number.isFinite(sample.predicted) || sample.predicted < 0 || sample.predicted > 1 ||
    typeof sample.correct !== 'boolean')) {
    throw new DomainError('INVALID_ARGUMENT', 'Calibration sample is invalid')
  }
  let total = 0
  for (let index = 0; index < bins; index += 1) {
    const lower = index / bins
    const upper = (index + 1) / bins
    const bucket = samples.filter((sample) =>
      sample.predicted >= lower && (index === bins - 1 ? sample.predicted <= upper : sample.predicted < upper))
    if (!bucket.length) continue
    const confidence = bucket.reduce((sum, sample) => sum + sample.predicted, 0) / bucket.length
    const accuracy = bucket.filter((sample) => sample.correct).length / bucket.length
    total += Math.abs(confidence - accuracy) * bucket.length / samples.length
  }
  return Number(total.toFixed(6))
}

export function evaluateCalibrationRegression(input: {
  datasetId: string
  calibrationVersion: string
  samples: readonly Readonly<CalibrationSample>[]
  bins: number
  maximumEce: number
}) {
  if (!REF.test(input.datasetId) || !VERSION.test(input.calibrationVersion) ||
      input.samples.length < 5 || input.samples.length > 10_000 ||
      !Number.isFinite(input.maximumEce) || input.maximumEce < 0 || input.maximumEce > 1 ||
      new Set(input.samples.map((sample) => sample.id)).size !== input.samples.length ||
      input.samples.some((sample) => !REF.test(sample.id))) {
    throw new DomainError('INVALID_ARGUMENT', 'Calibration regression input is invalid')
  }
  const ece = expectedCalibrationError(input.samples, input.bins)
  const body = Object.freeze({
    schemaVersion: 'confidence-calibration-eval/v1' as const,
    datasetId: input.datasetId,
    calibrationVersion: input.calibrationVersion,
    bins: input.bins,
    sampleCount: input.samples.length,
    maximumEce: input.maximumEce,
    ece,
    passed: ece <= input.maximumEce,
  })
  return Object.freeze({ ...body, evaluationHash: calculateCanonicalHash(body) })
}

export const CONFIDENCE_CALIBRATION_GOLDEN = Object.freeze({
  datasetId: 'confidence-golden-v1',
  calibrationVersion: 'director-confidence-2026-08-v1',
  bins: 5,
  maximumEce: 0.18,
  samples: Object.freeze([
    { id: 'sample-01', predicted: 0.95, correct: true },
    { id: 'sample-02', predicted: 0.9, correct: true },
    { id: 'sample-03', predicted: 0.82, correct: true },
    { id: 'sample-04', predicted: 0.78, correct: true },
    { id: 'sample-05', predicted: 0.7, correct: false },
    { id: 'sample-06', predicted: 0.62, correct: true },
    { id: 'sample-07', predicted: 0.55, correct: false },
    { id: 'sample-08', predicted: 0.4, correct: false },
    { id: 'sample-09', predicted: 0.25, correct: false },
    { id: 'sample-10', predicted: 0.1, correct: false },
  ]),
})
