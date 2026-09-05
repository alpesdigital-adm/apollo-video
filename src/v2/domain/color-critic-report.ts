import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  assertCameraColorMeasurementIntegrity,
  assertSessionTickInterval,
  measuredComponent,
  measuredValue,
  serializeTicksDeep,
  type CameraColorMeasurement,
  type ColorEvaluatorKind,
} from './color-measurement.ts'
import { assertDomain } from './errors.ts'
import {
  assertMulticamMatchPlanIntegrity,
  type MulticamMatchPlan,
} from './multicam-match-plan.ts'
import { intervalIntersection, intervalsOverlap, type TickInterval } from './session-time.ts'

/**
 * The colour critic (F4.014, FR-184).
 *
 * ADR-147 applied to colour, without a single line of it relaxed:
 *
 * - **Every dimension answers.** Twelve of them, each `measured`,
 *   `not-applicable` or `unavailable`. Silence is refused at construction.
 * - **Evidence-unavailable is a decision, not an approval.** EVERY dimension
 *   that could not be read localizes an `insufficient-evidence` issue and
 *   sends the report to a human — `hard` when the dimension is required,
 *   `warning` otherwise, but never nothing: "nobody could read it" may not
 *   resolve to "no defect found". `not-applicable` (there was nothing to
 *   read: no skin pixels, one camera, no declared brand colour) is the only
 *   honest silence, and it is not an approval either — nothing was judged.
 * - **The action follows a cause table, never an aggregate score.**
 *   `COLOR_CRITIC_CAUSE_ACTIONS` is that table; the winning cause is written
 *   into the report so the reason survives to whoever reads it later.
 * - **Evaluator kind travels with the number.** The band mask that finds skin
 *   pixels is `controlled`; the critic itself is `controlled` too, because it
 *   compares aggregates against versioned thresholds and reads no pixel of its
 *   own. Neither is production perceptual validation and neither pretends to
 *   be.
 *
 * The two stages the report covers are the colour pre-pass intermediate
 * (`before-output-transform`: technical → match → creative LUT already
 * applied) and the delivered render (`after-output-transform`). A creative
 * LUT is therefore visible as the difference between them, which is exactly
 * why a declared creative intent can excuse a cast and can never excuse
 * clipping, crushed blacks or an invalid skin tone: the intent bounds a
 * colour shift, not a destroyed sample.
 */

export const COLOR_CRITIC_REPORT_SCHEMA_VERSION = 'color-critic-report/v1' as const

export const COLOR_CRITIC_STAGES = Object.freeze([
  'before-output-transform',
  'after-output-transform',
] as const)
export type ColorCriticStage = (typeof COLOR_CRITIC_STAGES)[number]

/** A dimension read across the two stages rather than inside one of them. */
export const COLOR_CRITIC_ACROSS_STAGES = 'across-output-transform' as const
export type ColorCriticStageScope = ColorCriticStage | typeof COLOR_CRITIC_ACROSS_STAGES

export const COLOR_CRITIC_DIMENSIONS = Object.freeze([
  'clipping',
  'crushedBlacks',
  'cast',
  'whiteBalanceMismatch',
  'exposureMismatch',
  'saturationExcess',
  'saturationDeficit',
  'skinToneOffTarget',
  'localizedMismatch',
  'brandColorDrift',
  'hdrSdrInconsistency',
  'matchRegression',
] as const)
export type ColorCriticDimension = (typeof COLOR_CRITIC_DIMENSIONS)[number]

export const COLOR_CRITIC_STATUSES = Object.freeze([
  'measured',
  'not-applicable',
  'unavailable',
] as const)
export type ColorCriticStatus = (typeof COLOR_CRITIC_STATUSES)[number]

export const COLOR_CRITIC_SEVERITIES = Object.freeze(['hard', 'warning'] as const)
export type ColorCriticSeverity = (typeof COLOR_CRITIC_SEVERITIES)[number]

export const COLOR_CRITIC_CLASSIFICATIONS = Object.freeze([
  'technical-defect',
  'documented-intent',
  'insufficient-evidence',
  'localized',
  'global',
] as const)
export type ColorCriticClassification = (typeof COLOR_CRITIC_CLASSIFICATIONS)[number]

export const COLOR_CRITIC_ACTIONS = Object.freeze([
  'approve',
  'bounded-correction',
  'human-review',
  'reject',
] as const)
export type ColorCriticAction = (typeof COLOR_CRITIC_ACTIONS)[number]

export const COLOR_CRITIC_SUBJECT_KINDS = Object.freeze([
  'source',
  'camera',
  'range',
  'output',
] as const)
export type ColorCriticSubjectKind = (typeof COLOR_CRITIC_SUBJECT_KINDS)[number]

/**
 * The cause table (ADR-147 L36-40). Each cause names one remedy; the action is
 * looked up here and never averaged out of the numbers. `CAUSE_PRECEDENCE` is
 * the order in which causes are considered: a hard defect that was actually
 * measured outranks a dimension that could not be read, because knowing a
 * frame is clipped is not made less certain by a second question nobody could
 * answer. Everything below a measured hard defect fails towards a human.
 */
export const COLOR_CRITIC_CAUSES = Object.freeze([
  'irreversible-technical-defect',
  'evidence-unavailable',
  'correction-budget-exhausted',
  'correction-confidence-insufficient',
  'correction-out-of-bounds',
  'correction-not-derivable',
  'correctable-technical-defect',
  'advisory-warning',
  'documented-intent',
  'no-defect',
] as const)
export type ColorCriticCause = (typeof COLOR_CRITIC_CAUSES)[number]

export const COLOR_CRITIC_CAUSE_ACTIONS = Object.freeze({
  'irreversible-technical-defect': 'reject',
  'evidence-unavailable': 'human-review',
  'correction-budget-exhausted': 'human-review',
  'correction-confidence-insufficient': 'human-review',
  'correction-out-of-bounds': 'human-review',
  'correction-not-derivable': 'human-review',
  'correctable-technical-defect': 'bounded-correction',
  'advisory-warning': 'approve',
  'documented-intent': 'approve',
  'no-defect': 'approve',
} as const satisfies Readonly<Record<ColorCriticCause, ColorCriticAction>>)

/** Considered in this order; the first cause that applies decides. */
export const COLOR_CRITIC_CAUSE_PRECEDENCE = COLOR_CRITIC_CAUSES

/**
 * The dimensions that describe one camera against another. They are
 * `not-applicable` with a single camera and required with two or more: an
 * unreadable comparison on a multicamera subject is missing evidence, not an
 * absent defect. The match plan already refuses the identical evidence gap
 * with COLOR_RANGES_NOT_COMPARABLE; the critic must not wave it through.
 */
export const COLOR_CRITIC_BETWEEN_CAMERA_DIMENSIONS = Object.freeze([
  'whiteBalanceMismatch',
  'exposureMismatch',
  'localizedMismatch',
] as const satisfies readonly ColorCriticDimension[])

/**
 * Dimensions a defect in which cannot be undone by a `match`-stage gain: a
 * clipped sample carries no value to restore, a crushed one the same, a skin
 * tone outside its band is not a scalar the match can push back, and an
 * HDR/SDR inconsistency is a missing transform rather than a wrong number.
 */
export const COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS = Object.freeze([
  'clipping',
  'crushedBlacks',
  'skinToneOffTarget',
  'brandColorDrift',
  'hdrSdrInconsistency',
] as const satisfies readonly ColorCriticDimension[])

/** Dimensions a bounded re-derivation of the match stage can still address. */
export const COLOR_CRITIC_CORRECTABLE_DIMENSIONS = Object.freeze([
  'cast',
  'whiteBalanceMismatch',
  'exposureMismatch',
  'saturationExcess',
  'saturationDeficit',
  'localizedMismatch',
  'matchRegression',
] as const satisfies readonly ColorCriticDimension[])

/**
 * Dimensions that must be readable for any verdict at all. Skin, brand colour
 * and the between-camera dimensions are legitimately `not-applicable` when
 * their evidence does not exist; these five are not — if they cannot be read,
 * nothing about the bytes is known.
 */
export const COLOR_CRITIC_REQUIRED_DIMENSIONS = Object.freeze([
  'clipping',
  'crushedBlacks',
  'cast',
  'hdrSdrInconsistency',
  'matchRegression',
] as const satisfies readonly ColorCriticDimension[])

export const COLOR_CRITIC_UNITS = Object.freeze({
  clipping: 'ratio',
  crushedBlacks: 'ratio',
  cast: 'ratio-delta',
  whiteBalanceMismatch: 'ratio-delta',
  exposureMismatch: 'ev',
  saturationExcess: 'ratio',
  saturationDeficit: 'ratio',
  skinToneOffTarget: 'degrees',
  localizedMismatch: 'ratio',
  brandColorDrift: 'ratio-delta',
  hdrSdrInconsistency: 'count',
  matchRegression: 'count',
} as const satisfies Readonly<Record<ColorCriticDimension, string>>)

/**
 * Confidence bands, spec 01 §20. `bounded-correction` needs `high`; anything
 * less goes to a human, because an automatic reversible fix applied on a
 * number nobody trusts is the "auto-approve by silence" this repository
 * exists to prevent.
 */
export const COLOR_CRITIC_CONFIDENCE_BANDS = Object.freeze([
  { band: 'high', minimum: 0.85 },
  { band: 'medium', minimum: 0.65 },
  { band: 'low', minimum: 0.4 },
  { band: 'insufficient', minimum: 0 },
] as const)
export type ColorCriticConfidenceBand = (typeof COLOR_CRITIC_CONFIDENCE_BANDS)[number]['band']
export const COLOR_CRITIC_BOUNDED_CORRECTION_MINIMUM_CONFIDENCE = 0.85
export const COLOR_CRITIC_MAX_CORRECTION_ITERATIONS = 2

/**
 * Two thresholds per dimension, both versioned. `warn` raises an issue that
 * does not block; `hard` raises one that does. A single number would have made
 * "slightly over" and "ruined" the same verdict.
 */
export const DEFAULT_COLOR_CRITIC_THRESHOLDS = Object.freeze({
  calibrationVersion: 'color-critic-thresholds/v1',
  values: Object.freeze({
    clipping: Object.freeze({ warn: 0.005, hard: 0.02 }),
    crushedBlacks: Object.freeze({ warn: 0.005, hard: 0.02 }),
    cast: Object.freeze({ warn: 0.03, hard: 0.08 }),
    whiteBalanceMismatch: Object.freeze({ warn: 0.03, hard: 0.08 }),
    exposureMismatch: Object.freeze({ warn: 0.15, hard: 0.35 }),
    saturationExcess: Object.freeze({ warn: 1.15, hard: 1.35 }),
    saturationDeficit: Object.freeze({ warn: 0.87, hard: 0.7 }),
    skinToneOffTarget: Object.freeze({ warn: 8, hard: 15 }),
    localizedMismatch: Object.freeze({ warn: 0.001, hard: 0.001 }),
    brandColorDrift: Object.freeze({ warn: 0.03, hard: 0.08 }),
    hdrSdrInconsistency: Object.freeze({ warn: 1, hard: 1 }),
    matchRegression: Object.freeze({ warn: 1, hard: 1 }),
  }),
})
export type ColorCriticThresholds = typeof DEFAULT_COLOR_CRITIC_THRESHOLDS

export const DEFAULT_COLOR_CRITIC_POLICY = Object.freeze({
  /** Display gamma used to turn an encoded luma ratio into stops. */
  exposureGamma: 2.2,
  /** Hue, in degrees, at the centre of the YCbCr skin band the mask uses. */
  skinTargetHueDegrees: 136.13,
  /** Largest exposure correction a bounded correction may propose. */
  maxProposedExposureEv: 0.75,
  /** Largest per-channel gain a bounded correction may propose. */
  maxProposedGain: 1.25,
  /** Bounds on a proposed saturation multiplier. */
  proposedSaturationRange: Object.freeze([0.67, 1.5] as const),
  /** Below this share of the contrast it had before, the stage flattened the image. */
  contrastRegressionRatio: 0.7,
  /**
   * The largest cast a creative intent may declare as acceptable — twice the
   * `hard` cast threshold. Without a ceiling, `castAllowedDelta` is the caller
   * writing the verdict: declaring a big enough allowance turns any cast at
   * all into `documented-intent`/`approve`, which CONTRACT §2 and §6 forbid.
   * A look that needs more than this is a grade, and a human signs it off.
   * The number is `maxProposedGain - 1`: a declared look may shift a channel
   * ratio no further than the correction the match stage would be allowed to
   * apply to undo it.
   */
  maxDeclaredCastAllowance: 0.25,
})
export type ColorCriticPolicy = typeof DEFAULT_COLOR_CRITIC_POLICY

export interface ColorCriticEvaluator {
  readonly id: string
  readonly kind: ColorEvaluatorKind
  readonly version: string
  /** What this evaluator can and cannot answer, in the report itself. */
  readonly scope: string
}

/**
 * The critic reads no pixels. It compares measurement aggregates against
 * versioned thresholds, which makes it a `controlled` evaluator standing in
 * for a perceptual judgement that is not deployed — and it says so.
 */
export const COLOR_CRITIC_EVALUATOR: Readonly<ColorCriticEvaluator> = Object.freeze({
  id: 'apollo-color-critic',
  kind: 'controlled',
  version: COLOR_CRITIC_REPORT_SCHEMA_VERSION,
  scope: 'compares camera colour measurements against versioned thresholds; it decodes nothing itself and cannot judge appearance',
})

export interface ColorCriticSubject {
  readonly kind: ColorCriticSubjectKind
  readonly sourceAssetId?: string
  readonly cameraId?: string
  readonly artifactId?: string
  readonly range?: Readonly<TickInterval>
}

export interface ColorCriticBytes {
  readonly artifactId: string
  readonly sha256: string
}

export interface ColorCriticSection {
  readonly stage: ColorCriticStage
  readonly bytesEvaluated: readonly Readonly<ColorCriticBytes>[]
  readonly measurementIds: readonly string[]
  readonly measurements: readonly Readonly<CameraColorMeasurement>[]
}

export interface ColorCriticDimensionResult {
  readonly dimension: ColorCriticDimension
  readonly status: ColorCriticStatus
  readonly stage: ColorCriticStageScope
  readonly value?: number
  readonly unit?: string
  readonly threshold?: number
  readonly evaluatorIds?: readonly string[]
  readonly evidenceRefs?: readonly string[]
  readonly cameraIds?: readonly string[]
  readonly classification?: ColorCriticClassification
  readonly reason?: string
}

export interface ColorCriticIssue {
  readonly code: string
  readonly dimension: ColorCriticDimension
  readonly severity: ColorCriticSeverity
  readonly classification: ColorCriticClassification
  readonly cause: ColorCriticCause
  readonly stage: ColorCriticStageScope
  readonly cameraId: string | null
  readonly range: Readonly<TickInterval> | null
  /** `null` only for an insufficient-evidence issue: there is no number. */
  readonly measured: number | null
  readonly threshold: number | null
  readonly thresholdVersion: string
  readonly confidence: number
  readonly evidenceRefs: readonly string[]
}

export interface ColorCriticCreativeIntent {
  readonly declared: boolean
  /** How much cast the declared look is allowed to introduce, as a ratio delta. */
  readonly castAllowedDelta?: number
  readonly lutId?: string
  readonly note?: string
  /** Brand colours the look must protect. Declaring one makes the dimension required. */
  readonly brandColorsDeclared?: boolean
}

/**
 * Which `before` measurement was read against which `after` measurement, for
 * which camera. The cross-stage quantities (cast, saturation, regression) are
 * all differences within one of these pairs, so publishing the pairing is what
 * makes "the critic compared camera A with camera A" checkable from outside
 * instead of trusted.
 */
export interface ColorCriticStagePair {
  readonly cameraId: string
  readonly beforeMeasurementId: string
  readonly afterMeasurementId: string
}

/** The declared allowance and the ceiling that bound it, both auditable. */
export interface ColorCriticIntentBounds {
  readonly castAllowedDelta: number | null
  readonly maxDeclaredCastAllowance: number
}

export interface ColorCriticProposedDelta {
  readonly cameraId: string
  readonly exposureEv: number | null
  readonly whiteBalance: Readonly<{ redGain: number; greenGain: number; blueGain: number }> | null
  readonly saturation: number | null
}

export interface ColorCriticBoundedCorrection {
  readonly iteration: number
  readonly maxIterations: typeof COLOR_CRITIC_MAX_CORRECTION_ITERATIONS
  readonly proposedDeltas: readonly Readonly<ColorCriticProposedDelta>[]
  readonly reason: string
}

export interface ColorCriticReport {
  readonly schemaVersion: typeof COLOR_CRITIC_REPORT_SCHEMA_VERSION
  readonly reportId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly projectVersionId: string
  readonly subject: Readonly<ColorCriticSubject>
  readonly referenceCameraId: string | null
  readonly matchPlanId: string | null
  readonly matchPlanHash: string | null
  readonly sections: readonly Readonly<ColorCriticSection>[]
  readonly stagePairs: readonly Readonly<ColorCriticStagePair>[]
  readonly bytesEvaluated: readonly Readonly<ColorCriticBytes>[]
  readonly evaluators: readonly Readonly<ColorCriticEvaluator>[]
  readonly dimensions: readonly Readonly<ColorCriticDimensionResult>[]
  readonly issues: readonly Readonly<ColorCriticIssue>[]
  readonly creativeIntent: Readonly<ColorCriticCreativeIntent>
  readonly intentBounds: Readonly<ColorCriticIntentBounds>
  readonly cause: ColorCriticCause
  readonly action: ColorCriticAction
  readonly boundedCorrection: Readonly<ColorCriticBoundedCorrection> | null
  readonly confidence: number
  readonly confidenceBand: ColorCriticConfidenceBand
  readonly thresholds: Readonly<ColorCriticThresholds>
  readonly evaluatedAt: string
  readonly reportHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

function assertId(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

function assertToken(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && TOKEN.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical token`)
  return value
}

function assertInstant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort())
}

export function colorCriticConfidenceBand(confidence: number): ColorCriticConfidenceBand {
  for (const entry of COLOR_CRITIC_CONFIDENCE_BANDS) {
    if (confidence >= entry.minimum) return entry.band
  }
  return 'insufficient'
}

// ---------------------------------------------------------------------------
// Construction and integrity
// ---------------------------------------------------------------------------

export type ColorCriticReportContent = Omit<ColorCriticReport, 'reportHash'>

export function calculateColorCriticReportHash(content: Readonly<ColorCriticReportContent>): string {
  return calculateCanonicalHash(serializeTicksDeep(content))
}

function normalizedSubject(value: Readonly<ColorCriticSubject>): Readonly<ColorCriticSubject> {
  assertDomain(
    value && COLOR_CRITIC_SUBJECT_KINDS.includes(value.kind),
    'INVALID_ARGUMENT',
    'subject.kind must be one of source, camera, range or output',
  )
  const required: Readonly<Record<ColorCriticSubjectKind, readonly ('sourceAssetId' | 'cameraId' | 'artifactId' | 'range')[]>> = {
    source: ['sourceAssetId'],
    camera: ['cameraId'],
    range: ['cameraId', 'range'],
    output: ['artifactId'],
  }
  for (const field of required[value.kind]) {
    assertDomain(value[field] !== undefined, 'INVALID_ARGUMENT', `a ${value.kind} subject must name its ${field}`)
  }
  return Object.freeze({
    kind: value.kind,
    ...(value.sourceAssetId !== undefined ? { sourceAssetId: assertId(value.sourceAssetId, 'subject.sourceAssetId') } : {}),
    ...(value.cameraId !== undefined ? { cameraId: assertToken(value.cameraId, 'subject.cameraId') } : {}),
    ...(value.artifactId !== undefined ? { artifactId: assertId(value.artifactId, 'subject.artifactId') } : {}),
    // Built through the Wave 18 constructor, not copied: a subject range is
    // the one interval a caller hands the critic, and a millisecond float
    // would otherwise land in the canonically hashed body as a JS number
    // while every other range in the report hashes as decimal tick text.
    ...(value.range !== undefined ? { range: assertSessionTickInterval(value.range, 'subject.range') } : {}),
  })
}

/**
 * The declared creative intent, bounded.
 *
 * `castAllowedDelta` sets the pass/fail line for the `cast` dimension, so an
 * unvalidated one is the caller writing the verdict: a large enough allowance
 * turns any cast into `documented-intent`/`approve`, a negative one makes
 * every cast `hard` unconditionally, and `Infinity` escapes the canonical
 * hasher as a raw TypeError. It is a finite number inside the policy ceiling
 * or it is INVALID_ARGUMENT.
 */
function normalizedCreativeIntent(
  value: Readonly<ColorCriticCreativeIntent>,
  policy: ColorCriticPolicy,
): Readonly<ColorCriticCreativeIntent> {
  assertDomain(
    value !== null && typeof value === 'object' && typeof value.declared === 'boolean',
    'INVALID_ARGUMENT',
    'creativeIntent.declared must say whether an intent was declared at all',
  )
  if (value.castAllowedDelta !== undefined) {
    assertDomain(
      typeof value.castAllowedDelta === 'number' && Number.isFinite(value.castAllowedDelta) &&
        value.castAllowedDelta >= 0 && value.castAllowedDelta <= policy.maxDeclaredCastAllowance,
      'INVALID_ARGUMENT',
      `creativeIntent.castAllowedDelta must be within [0, ${policy.maxDeclaredCastAllowance}]; a larger allowance would let the declaration decide the verdict`,
      { received: value.castAllowedDelta, ceiling: policy.maxDeclaredCastAllowance },
    )
  }
  assertDomain(
    value.brandColorsDeclared === undefined || typeof value.brandColorsDeclared === 'boolean',
    'INVALID_ARGUMENT',
    'creativeIntent.brandColorsDeclared must be a boolean when present',
  )
  return Object.freeze({
    declared: value.declared,
    ...(value.castAllowedDelta !== undefined ? { castAllowedDelta: value.castAllowedDelta } : {}),
    ...(value.lutId !== undefined ? { lutId: assertId(value.lutId, 'creativeIntent.lutId') } : {}),
    ...(value.note !== undefined ? { note: value.note } : {}),
    ...(value.brandColorsDeclared !== undefined ? { brandColorsDeclared: value.brandColorsDeclared } : {}),
  })
}

/**
 * The thresholds every issue in the report claims to have been judged against.
 * A partial `values` object crashed `severityFor` with a raw TypeError, and a
 * complete but arbitrary one silently redefined every pass/fail line and was
 * then written into the hashed body as if it were the calibration.
 */
function normalizedThresholds(value: Readonly<ColorCriticThresholds>): Readonly<ColorCriticThresholds> {
  assertDomain(
    value !== null && typeof value === 'object' && typeof value.values === 'object' && value.values !== null,
    'INVALID_ARGUMENT',
    'thresholds must carry a calibrationVersion and a value for every dimension',
  )
  assertToken(value.calibrationVersion, 'thresholds.calibrationVersion')
  for (const dimension of COLOR_CRITIC_DIMENSIONS) {
    const band = value.values[dimension]
    assertDomain(
      band !== undefined && band !== null &&
        typeof band.warn === 'number' && Number.isFinite(band.warn) &&
        typeof band.hard === 'number' && Number.isFinite(band.hard),
      'INVALID_ARGUMENT',
      `thresholds.values.${dimension} must carry a finite warn and hard bound`,
      { dimension },
    )
  }
  return value
}

/**
 * The critic's own rates, checked the same way the match policy's are: a
 * gamma of zero would report every exposure difference as exactly 0 EV and a
 * zero regression ratio would make a flattened image look untouched.
 */
function normalizedCriticPolicy(overrides: Partial<ColorCriticPolicy> | undefined): ColorCriticPolicy {
  const policy = { ...DEFAULT_COLOR_CRITIC_POLICY, ...(overrides ?? {}) }
  for (const field of [
    'exposureGamma', 'maxProposedExposureEv', 'maxProposedGain',
    'contrastRegressionRatio', 'maxDeclaredCastAllowance',
  ] as const) {
    const value = policy[field]
    assertDomain(
      typeof value === 'number' && Number.isFinite(value) && value > 0,
      'INVALID_ARGUMENT',
      `policy.${field} must be a finite number greater than zero`,
      { field, received: value as unknown },
    )
  }
  assertDomain(
    typeof policy.skinTargetHueDegrees === 'number' && Number.isFinite(policy.skinTargetHueDegrees),
    'INVALID_ARGUMENT',
    'policy.skinTargetHueDegrees must be a finite angle',
  )
  assertDomain(
    Array.isArray(policy.proposedSaturationRange) && policy.proposedSaturationRange.length === 2 &&
      policy.proposedSaturationRange.every((bound) => typeof bound === 'number' && Number.isFinite(bound) && bound > 0) &&
      policy.proposedSaturationRange[0]! < policy.proposedSaturationRange[1]!,
    'INVALID_ARGUMENT',
    'policy.proposedSaturationRange must be an ordered pair of positive multipliers',
  )
  return Object.freeze(policy)
}

type ReportRefusal = 'INVALID_ARGUMENT' | 'PERSISTENCE_CONFLICT'

function normalizedDimension(
  value: Readonly<ColorCriticDimensionResult>,
  evaluatorIds: ReadonlySet<string>,
  code: ReportRefusal = 'INVALID_ARGUMENT',
): Readonly<ColorCriticDimensionResult> {
  const field = `dimensions.${value.dimension}`
  assertDomain(COLOR_CRITIC_STATUSES.includes(value.status), code, `${field}.status is invalid`)
  if (value.status === 'measured') {
    assertDomain(
      typeof value.value === 'number' && Number.isFinite(value.value),
      code,
      `${field} is measured and must carry a finite value`,
    )
    assertDomain(
      value.unit === COLOR_CRITIC_UNITS[value.dimension],
      code,
      `${field}.unit must be ${COLOR_CRITIC_UNITS[value.dimension]}`,
    )
    assertDomain(
      Array.isArray(value.evaluatorIds) && value.evaluatorIds.length > 0 &&
        value.evaluatorIds.every((id) => evaluatorIds.has(id)),
      code,
      `${field} must name evaluators the report lists`,
    )
    assertDomain(
      Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0,
      code,
      `${field} must reference the evidence it read`,
    )
    assertDomain(value.reason === undefined, code, `${field} is measured and must not carry a reason`)
    return Object.freeze({ ...value, evaluatorIds: Object.freeze([...value.evaluatorIds]), evidenceRefs: Object.freeze([...value.evidenceRefs]) })
  }
  assertDomain(
    value.value === undefined && value.unit === undefined && value.threshold === undefined &&
      value.evaluatorIds === undefined && value.evidenceRefs === undefined,
    code,
    `${field} is ${value.status} and must not look like a measurement`,
  )
  assertDomain(
    typeof value.reason === 'string' && value.reason.trim().length >= 10,
    code,
    `${field} is ${value.status} and must say why in words`,
  )
  return Object.freeze({ ...value })
}

/**
 * The ADR-147 shape rules, in one place, run by the constructor AND by the
 * integrity door. A stored report is not necessarily one this process built:
 * it may have been written by an older build or edited and re-hashed, and
 * "approved while carrying a blocking issue" must be refused on the way out
 * as firmly as on the way in.
 */
function assertColorCriticReportInvariants(
  content: Readonly<ColorCriticReportContent>,
  code: ReportRefusal,
): void {
  assertDomain(
    content.sections.length === COLOR_CRITIC_STAGES.length &&
      COLOR_CRITIC_STAGES.every((stage, index) => content.sections[index]!.stage === stage),
    code,
    'a colour critic report covers both stages, before and after the output transform, in that order',
  )
  const evaluatorIds = new Set(content.evaluators.map((evaluator) => evaluator.id))
  assertDomain(
    evaluatorIds.has(COLOR_CRITIC_EVALUATOR.id),
    code,
    'the critic must list itself among the evaluators that produced the verdict',
  )
  const answered = new Set(content.dimensions.map((dimension) => dimension.dimension))
  for (const dimension of COLOR_CRITIC_DIMENSIONS) {
    assertDomain(answered.has(dimension), code, `the report is silent about ${dimension}; every dimension must answer`)
  }
  assertDomain(
    content.dimensions.length === COLOR_CRITIC_DIMENSIONS.length,
    code,
    'a dimension may be answered only once',
  )
  for (const dimension of content.dimensions) normalizedDimension(dimension, evaluatorIds, code)
  for (const [index, issue] of content.issues.entries()) {
    const field = `issues[${index}]`
    assertDomain(COLOR_CRITIC_SEVERITIES.includes(issue.severity), code, `${field}.severity is invalid`)
    assertDomain(COLOR_CRITIC_CLASSIFICATIONS.includes(issue.classification), code, `${field}.classification is invalid`)
    assertDomain(COLOR_CRITIC_CAUSES.includes(issue.cause), code, `${field}.cause is invalid`)
    const evidenceless = issue.classification === 'insufficient-evidence'
    assertDomain(
      evidenceless === (issue.measured === null) && evidenceless === (issue.threshold === null),
      code,
      `${field} may omit its numbers only when it reports missing evidence`,
    )
    assertDomain(
      typeof issue.confidence === 'number' && issue.confidence >= 0 && issue.confidence <= 1,
      code,
      `${field}.confidence must be within [0, 1]`,
    )
  }
  assertDomain(
    COLOR_CRITIC_CAUSES.includes(content.cause) && COLOR_CRITIC_CAUSE_ACTIONS[content.cause] === content.action,
    code,
    'the action must be the one the cause table maps the cause to',
    { cause: content.cause, action: content.action },
  )
  // ADR-147: approval must be clean, a rejection must localize at least one
  // issue, and evidence-unavailable must point at what it could not read.
  assertDomain(
    content.action !== 'approve' || content.issues.every((issue) => issue.severity !== 'hard'),
    code,
    'an approved report cannot carry a blocking issue',
  )
  assertDomain(
    content.action !== 'reject' || content.issues.some((issue) => issue.severity === 'hard'),
    code,
    'a rejection must localize at least one blocking issue',
  )
  assertDomain(
    content.cause !== 'evidence-unavailable' ||
      content.issues.some((issue) => issue.classification === 'insufficient-evidence'),
    code,
    'an evidence-unavailable verdict must point at the dimension it could not evaluate',
  )
  // Nothing may be approved while a dimension went unread: an unavailable
  // dimension always localizes an insufficient-evidence issue, so a clean
  // approval and an unread dimension cannot both be true.
  assertDomain(
    content.action !== 'approve' ||
      content.dimensions.every((dimension) => dimension.status !== 'unavailable'),
    code,
    'a report that could not read a dimension cannot approve; evidence-unavailable is a decision, not an approval',
  )
  if (content.boundedCorrection) {
    assertDomain(
      content.action === 'bounded-correction',
      code,
      'only a bounded-correction verdict carries a bounded correction',
    )
    assertDomain(
      Number.isSafeInteger(content.boundedCorrection.iteration) &&
        content.boundedCorrection.iteration >= 1 &&
        content.boundedCorrection.iteration <= COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
      code,
      `a bounded correction runs at most ${COLOR_CRITIC_MAX_CORRECTION_ITERATIONS} times`,
      { iteration: content.boundedCorrection.iteration },
    )
    assertDomain(
      content.boundedCorrection.proposedDeltas.length > 0,
      code,
      'a bounded correction must propose at least one delta',
    )
    assertDomain(
      content.confidence >= COLOR_CRITIC_BOUNDED_CORRECTION_MINIMUM_CONFIDENCE,
      code,
      'a bounded correction requires high confidence',
      { confidence: content.confidence },
    )
  } else {
    assertDomain(
      content.action !== 'bounded-correction',
      code,
      'a bounded-correction verdict must carry the correction it proposes',
    )
  }
}

function createColorCriticReport(content: Readonly<ColorCriticReportContent>): Readonly<ColorCriticReport> {
  const evaluatorIds = new Set(content.evaluators.map((evaluator) => evaluator.id))
  const dimensions = Object.freeze(content.dimensions.map((dimension) => normalizedDimension(dimension, evaluatorIds)))
  const issues = Object.freeze(content.issues.map((issue, index) => Object.freeze({
    ...issue,
    code: assertToken(issue.code, `issues[${index}].code`),
    evidenceRefs: Object.freeze([...issue.evidenceRefs]),
    range: issue.range ? assertSessionTickInterval(issue.range, `issues[${index}].range`) : null,
  })))
  const body: ColorCriticReportContent = Object.freeze({
    schemaVersion: COLOR_CRITIC_REPORT_SCHEMA_VERSION,
    reportId: assertId(content.reportId, 'reportId'),
    workspaceId: assertId(content.workspaceId, 'workspaceId'),
    projectId: assertId(content.projectId, 'projectId'),
    projectVersionId: assertId(content.projectVersionId, 'projectVersionId'),
    subject: normalizedSubject(content.subject),
    referenceCameraId: content.referenceCameraId === null ? null : assertToken(content.referenceCameraId, 'referenceCameraId'),
    matchPlanId: content.matchPlanId === null ? null : assertId(content.matchPlanId, 'matchPlanId'),
    matchPlanHash: content.matchPlanHash,
    sections: Object.freeze(content.sections.map((section) => Object.freeze({
      stage: section.stage,
      bytesEvaluated: Object.freeze(section.bytesEvaluated.map((bytes) => Object.freeze({ ...bytes }))),
      measurementIds: Object.freeze([...section.measurementIds]),
      measurements: Object.freeze(section.measurements.map((measurement) => assertCameraColorMeasurementIntegrity(measurement))),
    }))),
    stagePairs: Object.freeze(content.stagePairs.map((pair) => Object.freeze({
      cameraId: assertToken(pair.cameraId, 'stagePairs.cameraId'),
      beforeMeasurementId: assertId(pair.beforeMeasurementId, 'stagePairs.beforeMeasurementId'),
      afterMeasurementId: assertId(pair.afterMeasurementId, 'stagePairs.afterMeasurementId'),
    }))),
    bytesEvaluated: Object.freeze(content.bytesEvaluated.map((bytes) => {
      assertDomain(HASH.test(bytes.sha256), 'INVALID_ARGUMENT', 'bytesEvaluated.sha256 must be a lowercase SHA-256')
      return Object.freeze({ artifactId: assertId(bytes.artifactId, 'bytesEvaluated.artifactId'), sha256: bytes.sha256 })
    })),
    evaluators: Object.freeze(content.evaluators.map((evaluator) => Object.freeze({ ...evaluator }))),
    dimensions,
    issues,
    creativeIntent: Object.freeze({ ...content.creativeIntent }),
    intentBounds: Object.freeze({
      castAllowedDelta: content.intentBounds.castAllowedDelta,
      maxDeclaredCastAllowance: content.intentBounds.maxDeclaredCastAllowance,
    }),
    cause: content.cause,
    action: content.action,
    boundedCorrection: content.boundedCorrection
      ? Object.freeze({
          ...content.boundedCorrection,
          proposedDeltas: Object.freeze(content.boundedCorrection.proposedDeltas.map((delta) => Object.freeze({ ...delta }))),
        })
      : null,
    confidence: content.confidence,
    confidenceBand: colorCriticConfidenceBand(content.confidence),
    thresholds: content.thresholds,
    evaluatedAt: assertInstant(content.evaluatedAt, 'evaluatedAt'),
  })
  assertColorCriticReportInvariants(body, 'INVALID_ARGUMENT')
  return Object.freeze({ ...body, reportHash: calculateColorCriticReportHash(body) })
}

/** Re-verify a report read back from storage, hash and embedded evidence. */
export function assertColorCriticReportIntegrity(report: Readonly<ColorCriticReport>): Readonly<ColorCriticReport> {
  assertDomain(
    report.schemaVersion === COLOR_CRITIC_REPORT_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored colour critic report schema is unknown',
  )
  const { reportHash, ...content } = report
  assertDomain(
    calculateColorCriticReportHash(content) === reportHash,
    'PERSISTENCE_CONFLICT',
    'colour critic report hash does not match its stored content',
  )
  assertColorCriticReportInvariants(content, 'PERSISTENCE_CONFLICT')
  for (const section of report.sections) {
    for (const measurement of section.measurements) assertCameraColorMeasurementIntegrity(measurement)
  }
  return report
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface StagePair {
  readonly cameraId: string
  readonly before: Readonly<CameraColorMeasurement>
  readonly after: Readonly<CameraColorMeasurement>
}

interface CameraComparison {
  readonly cameraId: string
  readonly range: Readonly<TickInterval>
  readonly exposureEv: number | null
  readonly whiteBalanceDelta: number | null
  readonly evidenceRefs: readonly string[]
  readonly evaluatorIds: readonly string[]
  readonly confidence: number
}

function evaluatorRefs(
  measurements: readonly Readonly<CameraColorMeasurement>[],
): readonly Readonly<ColorCriticEvaluator>[] {
  const seen = new Map<string, Readonly<ColorCriticEvaluator>>()
  seen.set(COLOR_CRITIC_EVALUATOR.id, COLOR_CRITIC_EVALUATOR)
  for (const measurement of measurements) {
    for (const result of Object.values(measurement.dimensions)) {
      if (result.status !== 'measured' || !result.evaluator) continue
      if (seen.has(result.evaluator.id)) continue
      seen.set(result.evaluator.id, Object.freeze({
        id: result.evaluator.id,
        kind: result.evaluator.kind,
        version: result.evaluator.version,
        scope: result.evaluator.kind === 'controlled'
          ? 'a deterministic rule standing in for a model that is not deployed; it reports what its rule matched, never a perceptual judgement'
          : 'an instrument reading the evaluated bytes directly',
      }))
    }
  }
  return Object.freeze([...seen.values()].sort((left, right) => left.id.localeCompare(right.id)))
}

function evidenceOf(measurement: Readonly<CameraColorMeasurement>, dimension: 'exposure' | 'whiteBalance' | 'saturation' | 'blacks' | 'highlights' | 'skin' | 'contrast' | 'tonalResponse'): string | null {
  const result = measurement.dimensions[dimension]
  return result.status === 'measured' ? result.evidenceRef ?? null : null
}

function evaluatorOf(measurement: Readonly<CameraColorMeasurement>, dimension: 'exposure' | 'whiteBalance' | 'saturation' | 'blacks' | 'highlights' | 'skin' | 'contrast' | 'tonalResponse'): string | null {
  const result = measurement.dimensions[dimension]
  return result.status === 'measured' ? result.evaluator?.id ?? null : null
}

function pairStages(
  before: readonly Readonly<CameraColorMeasurement>[],
  after: readonly Readonly<CameraColorMeasurement>[],
): readonly StagePair[] {
  const pairs: StagePair[] = []
  for (const afterMeasurement of after) {
    let best: Readonly<CameraColorMeasurement> | null = null
    let bestOverlap = BigInt(0)
    for (const beforeMeasurement of before) {
      if (beforeMeasurement.cameraId !== afterMeasurement.cameraId) continue
      const overlap = intervalIntersection(beforeMeasurement.range, afterMeasurement.range)
      if (!overlap) continue
      const duration = overlap.end - overlap.start
      if (best === null || duration > bestOverlap) {
        best = beforeMeasurement
        bestOverlap = duration
      }
    }
    if (best) pairs.push({ cameraId: afterMeasurement.cameraId, before: best, after: afterMeasurement })
  }
  return pairs
}

function castDelta(pair: StagePair): number | null {
  const rBefore = measuredComponent(pair.before, 'whiteBalance', 'rOverG')
  const rAfter = measuredComponent(pair.after, 'whiteBalance', 'rOverG')
  const bBefore = measuredComponent(pair.before, 'whiteBalance', 'bOverG')
  const bAfter = measuredComponent(pair.after, 'whiteBalance', 'bOverG')
  if (rBefore === null || rAfter === null || bBefore === null || bAfter === null) return null
  if (rBefore === 0 || bBefore === 0) return null
  return Math.max(Math.abs(rAfter / rBefore - 1), Math.abs(bAfter / bBefore - 1))
}

function compareCameras(
  measurements: readonly Readonly<CameraColorMeasurement>[],
  referenceCameraId: string,
  policy: ColorCriticPolicy,
): readonly CameraComparison[] {
  const references = measurements.filter((measurement) => measurement.cameraId === referenceCameraId)
  const comparisons: CameraComparison[] = []
  for (const measurement of measurements) {
    if (measurement.cameraId === referenceCameraId) continue
    for (const reference of references) {
      if (!intervalsOverlap(measurement.range, reference.range)) continue
      const overlap = intervalIntersection(measurement.range, reference.range)!
      const yCamera = measuredValue(measurement, 'exposure')
      const yReference = measuredValue(reference, 'exposure')
      const rCamera = measuredComponent(measurement, 'whiteBalance', 'rOverG')
      const rReference = measuredComponent(reference, 'whiteBalance', 'rOverG')
      const bCamera = measuredComponent(measurement, 'whiteBalance', 'bOverG')
      const bReference = measuredComponent(reference, 'whiteBalance', 'bOverG')
      comparisons.push({
        cameraId: measurement.cameraId,
        range: overlap,
        exposureEv: yCamera !== null && yReference !== null && yCamera > 0 && yReference > 0
          ? policy.exposureGamma * Math.log2(yCamera / yReference)
          : null,
        whiteBalanceDelta: rCamera !== null && rReference !== null && bCamera !== null && bReference !== null && rReference > 0 && bReference > 0
          ? Math.max(Math.abs(rCamera / rReference - 1), Math.abs(bCamera / bReference - 1))
          : null,
        evidenceRefs: Object.freeze([
          evidenceOf(measurement, 'exposure'), evidenceOf(reference, 'exposure'),
          evidenceOf(measurement, 'whiteBalance'), evidenceOf(reference, 'whiteBalance'),
        ].filter((value): value is string => value !== null)),
        evaluatorIds: Object.freeze([
          evaluatorOf(measurement, 'exposure'), evaluatorOf(reference, 'exposure'),
        ].filter((value): value is string => value !== null)),
        confidence: Math.min(measurement.confidence, reference.confidence),
      })
    }
  }
  return Object.freeze(comparisons)
}

interface DimensionDraft {
  result: ColorCriticDimensionResult
  issues: ColorCriticIssue[]
}

function severityFor(
  value: number,
  band: Readonly<{ warn: number; hard: number }>,
  direction: 'above' | 'below',
): ColorCriticSeverity | null {
  if (direction === 'above') {
    if (value >= band.hard) return 'hard'
    if (value >= band.warn) return 'warning'
    return null
  }
  if (value <= band.hard) return 'hard'
  if (value <= band.warn) return 'warning'
  return null
}

export interface EvaluateColorCriticInput {
  readonly reportId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly projectVersionId: string
  readonly subject: Readonly<ColorCriticSubject>
  /** Measurements of the colour pre-pass intermediate: match applied, output transform not. */
  readonly before: readonly Readonly<CameraColorMeasurement>[]
  /** Measurements of the delivered render. */
  readonly after: readonly Readonly<CameraColorMeasurement>[]
  readonly matchPlan?: Readonly<MulticamMatchPlan>
  readonly creativeIntent: Readonly<ColorCriticCreativeIntent>
  /** How many bounded corrections have already been applied to this subject. */
  readonly correctionsApplied?: number
  readonly policy?: Partial<ColorCriticPolicy>
  readonly thresholds?: Readonly<ColorCriticThresholds>
  readonly evaluatedAt: string
}

/**
 * Judge the two stages and say what to do about them.
 *
 * The caller supplies bytes and measurements; it supplies no verdict, no
 * score and no approval. Every dimension is answered here, every issue names
 * the threshold and calibration version it was judged against, and the action
 * comes out of the cause table rather than out of an average.
 */
export function evaluateColorCritic(input: EvaluateColorCriticInput): Readonly<ColorCriticReport> {
  const policy = normalizedCriticPolicy(input.policy)
  const thresholds = normalizedThresholds(input.thresholds ?? DEFAULT_COLOR_CRITIC_THRESHOLDS)
  const creativeIntent = normalizedCreativeIntent(input.creativeIntent, policy)
  const bands = thresholds.values
  const version = thresholds.calibrationVersion
  assertDomain(
    Array.isArray(input.before) && input.before.length > 0 && Array.isArray(input.after) && input.after.length > 0,
    'INVALID_ARGUMENT',
    'a colour critic report needs measurements of both stages; one of them alone cannot show what the output transform did',
  )
  const before = input.before.map((measurement) => assertCameraColorMeasurementIntegrity(measurement))
  const after = input.after.map((measurement) => assertCameraColorMeasurementIntegrity(measurement))
  const matchPlan = input.matchPlan ? assertMulticamMatchPlanIntegrity(input.matchPlan) : null
  const correctionsApplied = input.correctionsApplied ?? 0
  assertDomain(
    Number.isSafeInteger(correctionsApplied) && correctionsApplied >= 0,
    'INVALID_ARGUMENT',
    'correctionsApplied must be a non-negative integer',
  )
  const cameraIds = [...new Set(after.map((measurement) => measurement.cameraId))].sort()
  const referenceCameraId = matchPlan?.referenceCameraId ?? cameraIds[0] ?? null
  const evaluators = evaluatorRefs([...before, ...after])
  const criticId = COLOR_CRITIC_EVALUATOR.id
  const pairs = pairStages(before, after)
  const comparisons = referenceCameraId ? compareCameras(after, referenceCameraId, policy) : []
  const drafts: DimensionDraft[] = []

  const issue = (
    dimension: ColorCriticDimension,
    severity: ColorCriticSeverity,
    classification: ColorCriticClassification,
    cause: ColorCriticCause,
    stage: ColorCriticStageScope,
    measured: number | null,
    threshold: number | null,
    confidence: number,
    evidenceRefs: readonly string[],
    cameraId: string | null = null,
    range: Readonly<TickInterval> | null = null,
  ): ColorCriticIssue => Object.freeze({
    code: `color-${dimension.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    dimension,
    severity,
    classification,
    cause,
    stage,
    cameraId,
    range,
    measured: measured === null ? null : round6(measured),
    threshold,
    thresholdVersion: version,
    confidence: round6(confidence),
    evidenceRefs: Object.freeze([...evidenceRefs]),
  })

  // A declared brand colour makes its dimension required, and so does a second
  // camera for the three between-camera dimensions: asking for a check nobody
  // can run is answered by a human, never by silence.
  const required = new Set<string>([
    ...COLOR_CRITIC_REQUIRED_DIMENSIONS,
    ...(creativeIntent.brandColorsDeclared === true ? ['brandColorDrift'] : []),
    ...(cameraIds.length >= 2 ? COLOR_CRITIC_BETWEEN_CAMERA_DIMENSIONS : []),
  ])

  /**
   * An unread dimension always localizes an issue — `hard` when the dimension
   * is required for a verdict, `warning` otherwise. Never nothing: silence
   * here was how two cameras a full stop apart, measured on ranges that never
   * overlap, came out `no-defect`/`approve`.
   */
  const unavailableDimension = (
    dimension: ColorCriticDimension,
    stage: ColorCriticStageScope,
    reason: string,
    confidence: number,
  ): DimensionDraft => ({
    result: { dimension, status: 'unavailable', stage, reason },
    issues: [issue(
      dimension,
      required.has(dimension) ? 'hard' : 'warning',
      'insufficient-evidence', 'evidence-unavailable', stage, null, null, confidence, [],
    )],
  })

  const notApplicableDimension = (
    dimension: ColorCriticDimension,
    stage: ColorCriticStageScope,
    reason: string,
  ): DimensionDraft => ({ result: { dimension, status: 'not-applicable', stage, reason }, issues: [] })

  const measurementConfidence = Math.min(
    ...before.map((measurement) => measurement.confidence),
    ...after.map((measurement) => measurement.confidence),
  )

  // --- clipping and crushed blacks: read on the delivered bytes -------------
  for (const [dimension, source, band] of [
    ['clipping', 'highlights', bands.clipping],
    ['crushedBlacks', 'blacks', bands.crushedBlacks],
  ] as const) {
    const missing = after.filter((measurement) => measurement.dimensions[source].status !== 'measured')
    if (missing.length > 0) {
      drafts.push(unavailableDimension(
        dimension,
        'after-output-transform',
        `${source} could not be read for ${missing.map((measurement) => measurement.cameraId).join(', ')}; a delivered frame with unknown ${source} cannot be approved`,
        measurementConfidence,
      ))
      continue
    }
    let worst = after[0]!
    let worstValue = measuredValue(worst, source)!
    for (const measurement of after) {
      const value = measuredValue(measurement, source)!
      if (value > worstValue) {
        worst = measurement
        worstValue = value
      }
    }
    const severity = severityFor(worstValue, band, 'above')
    drafts.push({
      result: {
        dimension,
        status: 'measured',
        stage: 'after-output-transform',
        value: round6(worstValue),
        unit: COLOR_CRITIC_UNITS[dimension],
        threshold: band.hard,
        evaluatorIds: unique([criticId, ...after.map((measurement) => evaluatorOf(measurement, source)).filter((id): id is string => id !== null)]),
        evidenceRefs: unique(after.map((measurement) => evidenceOf(measurement, source)).filter((ref): ref is string => ref !== null)),
        cameraIds: unique(after.map((measurement) => measurement.cameraId)),
        ...(severity ? { classification: 'technical-defect' as const } : {}),
      },
      issues: severity
        ? [issue(
            dimension, severity, 'technical-defect',
            severity === 'hard' ? 'irreversible-technical-defect' : 'advisory-warning',
            'after-output-transform', worstValue, severity === 'hard' ? band.hard : band.warn,
            worst.confidence, [evidenceOf(worst, source)!], worst.cameraId, worst.range,
          )]
        : [],
    })
  }

  // --- cast: what the output transform and the creative LUT did ------------
  {
    const deltas = pairs.map((pair) => ({ pair, delta: castDelta(pair) }))
    const unreadable = deltas.filter((entry) => entry.delta === null)
    if (pairs.length === 0) {
      drafts.push(unavailableDimension(
        'cast', COLOR_CRITIC_ACROSS_STAGES,
        'no camera was measured on both sides of the output transform, so no cast can be attributed to it',
        measurementConfidence,
      ))
    } else if (unreadable.length > 0) {
      drafts.push(unavailableDimension(
        'cast', COLOR_CRITIC_ACROSS_STAGES,
        `white balance was not readable on both sides for ${unreadable.map((entry) => entry.pair.cameraId).join(', ')}; a cast cannot be separated from an unread channel`,
        measurementConfidence,
      ))
    } else {
      let worst = deltas[0]!
      for (const entry of deltas) if (entry.delta! > worst.delta!) worst = entry
      const value = worst.delta!
      const declared = creativeIntent.declared === true && typeof creativeIntent.castAllowedDelta === 'number'
      const allowance = declared ? creativeIntent.castAllowedDelta! : null
      const withinIntent = allowance !== null && value <= allowance
      const severity = withinIntent ? null : allowance !== null ? 'hard' : severityFor(value, bands.cast, 'above')
      const evidence = unique(pairs.flatMap((pair) => [evidenceOf(pair.before, 'whiteBalance'), evidenceOf(pair.after, 'whiteBalance')].filter((ref): ref is string => ref !== null)))
      drafts.push({
        result: {
          dimension: 'cast',
          status: 'measured',
          stage: COLOR_CRITIC_ACROSS_STAGES,
          value: round6(value),
          unit: COLOR_CRITIC_UNITS.cast,
          threshold: allowance ?? bands.cast.hard,
          evaluatorIds: unique([criticId, ...pairs.map((pair) => evaluatorOf(pair.after, 'whiteBalance')).filter((id): id is string => id !== null)]),
          evidenceRefs: evidence,
          cameraIds: unique(pairs.map((pair) => pair.cameraId)),
          // A declared look that stayed inside its declared budget is intent,
          // not a defect. The same numbers without the declaration are a
          // defect: the difference is the declaration, and it is recorded.
          ...(withinIntent ? { classification: 'documented-intent' as const } : severity ? { classification: 'technical-defect' as const } : {}),
        },
        issues: severity
          ? [issue(
              'cast', severity, 'technical-defect',
              severity === 'hard' ? 'correctable-technical-defect' : 'advisory-warning',
              COLOR_CRITIC_ACROSS_STAGES, value, allowance ?? (severity === 'hard' ? bands.cast.hard : bands.cast.warn),
              Math.min(worst.pair.before.confidence, worst.pair.after.confidence),
              [evidenceOf(worst.pair.after, 'whiteBalance')!], worst.pair.cameraId, worst.pair.after.range,
            )]
          : [],
      })
    }
  }

  // --- between-camera dimensions on the delivered bytes ---------------------
  for (const [dimension, pick, band] of [
    ['whiteBalanceMismatch', (comparison: CameraComparison) => comparison.whiteBalanceDelta, bands.whiteBalanceMismatch],
    ['exposureMismatch', (comparison: CameraComparison) => comparison.exposureEv === null ? null : Math.abs(comparison.exposureEv), bands.exposureMismatch],
  ] as const) {
    if (cameraIds.length < 2) {
      drafts.push(notApplicableDimension(
        dimension, 'after-output-transform',
        'only one camera was measured; there is no second camera for it to differ from',
      ))
      continue
    }
    if (comparisons.length === 0) {
      drafts.push(unavailableDimension(
        dimension, 'after-output-transform',
        'the cameras were measured on ranges that never overlap, so no pair of them describes the same moment',
        measurementConfidence,
      ))
      continue
    }
    const values = comparisons.map((comparison) => ({ comparison, value: pick(comparison) }))
    if (values.some((entry) => entry.value === null)) {
      drafts.push(unavailableDimension(
        dimension, 'after-output-transform',
        'a camera in the comparison did not carry the measurement the mismatch is computed from',
        measurementConfidence,
      ))
      continue
    }
    let worst = values[0]!
    for (const entry of values) if (entry.value! > worst.value!) worst = entry
    const severity = severityFor(worst.value!, band, 'above')
    drafts.push({
      result: {
        dimension,
        status: 'measured',
        stage: 'after-output-transform',
        value: round6(worst.value!),
        unit: COLOR_CRITIC_UNITS[dimension],
        threshold: band.hard,
        evaluatorIds: unique([criticId, ...comparisons.flatMap((comparison) => comparison.evaluatorIds)]),
        evidenceRefs: unique(comparisons.flatMap((comparison) => comparison.evidenceRefs)),
        cameraIds: unique(comparisons.map((comparison) => comparison.cameraId)),
        ...(severity ? { classification: 'technical-defect' as const } : {}),
      },
      issues: severity
        ? [issue(
            dimension, severity, 'technical-defect',
            severity === 'hard' ? 'correctable-technical-defect' : 'advisory-warning',
            'after-output-transform', worst.value!, severity === 'hard' ? band.hard : band.warn,
            worst.comparison.confidence, worst.comparison.evidenceRefs, worst.comparison.cameraId, worst.comparison.range,
          )]
        : [],
    })
  }

  // --- saturation: what the output transform did to the chroma -------------
  {
    const ratios = pairs.map((pair) => {
      const beforeValue = measuredValue(pair.before, 'saturation')
      const afterValue = measuredValue(pair.after, 'saturation')
      return { pair, ratio: beforeValue !== null && afterValue !== null && beforeValue > 0 ? afterValue / beforeValue : null }
    })
    const readable = ratios.filter((entry) => entry.ratio !== null)
    for (const [dimension, direction, band] of [
      ['saturationExcess', 'above', bands.saturationExcess],
      ['saturationDeficit', 'below', bands.saturationDeficit],
    ] as const) {
      if (pairs.length === 0 || readable.length !== ratios.length) {
        drafts.push(unavailableDimension(
          dimension, COLOR_CRITIC_ACROSS_STAGES,
          'saturation was not readable on both sides of the output transform for every camera',
          measurementConfidence,
        ))
        continue
      }
      let worst = readable[0]!
      for (const entry of readable) {
        if (direction === 'above' ? entry.ratio! > worst.ratio! : entry.ratio! < worst.ratio!) worst = entry
      }
      const severity = severityFor(worst.ratio!, band, direction)
      drafts.push({
        result: {
          dimension,
          status: 'measured',
          stage: COLOR_CRITIC_ACROSS_STAGES,
          value: round6(worst.ratio!),
          unit: COLOR_CRITIC_UNITS[dimension],
          threshold: band.hard,
          evaluatorIds: unique([criticId, ...pairs.map((pair) => evaluatorOf(pair.after, 'saturation')).filter((id): id is string => id !== null)]),
          evidenceRefs: unique(pairs.flatMap((pair) => [evidenceOf(pair.before, 'saturation'), evidenceOf(pair.after, 'saturation')].filter((ref): ref is string => ref !== null))),
          cameraIds: unique(pairs.map((pair) => pair.cameraId)),
          ...(severity ? { classification: 'technical-defect' as const } : {}),
        },
        issues: severity
          ? [issue(
              dimension, severity, 'technical-defect',
              severity === 'hard' ? 'correctable-technical-defect' : 'advisory-warning',
              COLOR_CRITIC_ACROSS_STAGES, worst.ratio!, severity === 'hard' ? band.hard : band.warn,
              Math.min(worst.pair.before.confidence, worst.pair.after.confidence),
              [evidenceOf(worst.pair.after, 'saturation')!], worst.pair.cameraId, worst.pair.after.range,
            )]
          : [],
      })
    }
  }

  // --- skin: only where there is skin-band evidence ------------------------
  {
    const measuredSkin = after.filter((measurement) => measurement.dimensions.skin.status === 'measured')
    const unreadableSkin = after.filter((measurement) => measurement.dimensions.skin.status === 'unavailable')
    if (measuredSkin.length === 0 && unreadableSkin.length > 0) {
      drafts.push(unavailableDimension(
        'skinToneOffTarget', 'after-output-transform',
        'the skin band could not be evaluated on the delivered frames',
        measurementConfidence,
      ))
    } else if (measuredSkin.length === 0) {
      // Absence of skin-band pixels is an honest not-applicable. It is never
      // an approval: nothing was judged, so nothing was found acceptable.
      drafts.push(notApplicableDimension(
        'skinToneOffTarget', 'after-output-transform',
        'no frame carried enough pixels inside the skin band to measure; no skin tone was judged here',
      ))
    } else {
      let worst = measuredSkin[0]!
      let worstOffset = 0
      for (const measurement of measuredSkin) {
        const hue = measuredValue(measurement, 'skin')!
        const raw = Math.abs(hue - policy.skinTargetHueDegrees) % 360
        const offset = raw > 180 ? 360 - raw : raw
        if (offset > worstOffset) {
          worst = measurement
          worstOffset = offset
        }
      }
      const severity = severityFor(worstOffset, bands.skinToneOffTarget, 'above')
      drafts.push({
        result: {
          dimension: 'skinToneOffTarget',
          status: 'measured',
          stage: 'after-output-transform',
          value: round6(worstOffset),
          unit: COLOR_CRITIC_UNITS.skinToneOffTarget,
          threshold: bands.skinToneOffTarget.hard,
          evaluatorIds: unique([criticId, ...measuredSkin.map((measurement) => evaluatorOf(measurement, 'skin')).filter((id): id is string => id !== null)]),
          evidenceRefs: unique(measuredSkin.map((measurement) => evidenceOf(measurement, 'skin')).filter((ref): ref is string => ref !== null)),
          cameraIds: unique(measuredSkin.map((measurement) => measurement.cameraId)),
          ...(severity ? { classification: 'technical-defect' as const } : {}),
        },
        issues: severity
          ? [issue(
              'skinToneOffTarget', severity, 'technical-defect',
              severity === 'hard' ? 'irreversible-technical-defect' : 'advisory-warning',
              'after-output-transform', worstOffset, severity === 'hard' ? bands.skinToneOffTarget.hard : bands.skinToneOffTarget.warn,
              worst.confidence, [evidenceOf(worst, 'skin')!], worst.cameraId, worst.range,
            )]
          : [],
      })
    }
  }

  // --- localized versus global mismatch ------------------------------------
  {
    if (cameraIds.length < 2) {
      drafts.push(notApplicableDimension(
        'localizedMismatch', 'after-output-transform',
        'a mismatch needs two cameras; only one was measured on the delivered bytes',
      ))
    } else if (comparisons.length === 0) {
      drafts.push(unavailableDimension(
        'localizedMismatch', 'after-output-transform',
        'no two cameras were measured over an overlapping range, so no range could be compared',
        measurementConfidence,
      ))
    } else {
      const offending = comparisons.filter((comparison) =>
        (comparison.exposureEv !== null && Math.abs(comparison.exposureEv) >= bands.exposureMismatch.hard) ||
        (comparison.whiteBalanceDelta !== null && comparison.whiteBalanceDelta >= bands.whiteBalanceMismatch.hard))
      const share = offending.length / comparisons.length
      // One range out of several is a local problem and is fixed locally; every
      // range is the correction itself being wrong.
      const classification: ColorCriticClassification = offending.length === comparisons.length ? 'global' : 'localized'
      const severity = offending.length === 0 ? null : severityFor(share, bands.localizedMismatch, 'above')
      drafts.push({
        result: {
          dimension: 'localizedMismatch',
          status: 'measured',
          stage: 'after-output-transform',
          value: round6(share),
          unit: COLOR_CRITIC_UNITS.localizedMismatch,
          threshold: bands.localizedMismatch.hard,
          evaluatorIds: unique([criticId, ...comparisons.flatMap((comparison) => comparison.evaluatorIds)]),
          evidenceRefs: unique(comparisons.flatMap((comparison) => comparison.evidenceRefs)),
          cameraIds: unique(comparisons.map((comparison) => comparison.cameraId)),
          ...(offending.length > 0 ? { classification } : {}),
        },
        issues: severity
          ? offending.map((comparison) => issue(
              'localizedMismatch', severity, classification, 'correctable-technical-defect',
              'after-output-transform', share, bands.localizedMismatch.hard,
              comparison.confidence, comparison.evidenceRefs, comparison.cameraId, comparison.range,
            ))
          : [],
      })
    }
  }

  // --- brand colour: no instrument, so never silently approved -------------
  drafts.push(creativeIntent.brandColorsDeclared === true
    ? unavailableDimension(
        'brandColorDrift', 'after-output-transform',
        'brand colours were declared but no brand-colour evaluator is deployed; the drift was not measured and is not assumed absent',
        measurementConfidence,
      )
    : notApplicableDimension(
        'brandColorDrift', 'after-output-transform',
        'no brand colour was declared for this project, so there is no target to drift from',
      ))

  // --- HDR/SDR consistency --------------------------------------------------
  {
    const nonSdr = [...before, ...after].filter((measurement) => measurement.technical.hdrMode !== 'sdr')
    const changed = pairs.filter((pair) => pair.before.technical.hdrMode !== pair.after.technical.hdrMode)
    const count = nonSdr.length + changed.length
    const severity = severityFor(count, bands.hdrSdrInconsistency, 'above')
    drafts.push({
      result: {
        dimension: 'hdrSdrInconsistency',
        status: 'measured',
        stage: COLOR_CRITIC_ACROSS_STAGES,
        value: count,
        unit: COLOR_CRITIC_UNITS.hdrSdrInconsistency,
        threshold: bands.hdrSdrInconsistency.hard,
        evaluatorIds: [criticId],
        evidenceRefs: unique([...before, ...after].map((measurement) => `technical:${measurement.measurementId}:${measurement.technical.hdrMode}`)),
        cameraIds: unique([...before, ...after].map((measurement) => measurement.cameraId)),
        ...(severity ? { classification: 'technical-defect' as const } : {}),
      },
      issues: severity
        ? [issue(
            'hdrSdrInconsistency', severity, 'technical-defect', 'irreversible-technical-defect',
            COLOR_CRITIC_ACROSS_STAGES, count, bands.hdrSdrInconsistency.hard, measurementConfidence,
            unique((nonSdr[0] ? [nonSdr[0]] : []).map((measurement) => `technical:${measurement.measurementId}`)),
            nonSdr[0]?.cameraId ?? changed[0]?.cameraId ?? null,
          )]
        : [],
    })
  }

  // --- match regression: good before, bad after ----------------------------
  {
    // A regression is a quantity that was inside its limit before the stage
    // and outside it after. Highlights and blacks are the two the critic also
    // reports on their own; contrast collapse is only visible here, which is
    // why the dimension is not redundant with `clipping`.
    const regressionChecks = [
      {
        source: 'highlights' as const,
        threshold: bands.clipping.hard,
        regressed: (pair: StagePair) =>
          measuredValue(pair.before, 'highlights')! < bands.clipping.hard &&
          measuredValue(pair.after, 'highlights')! >= bands.clipping.hard,
      },
      {
        source: 'blacks' as const,
        threshold: bands.crushedBlacks.hard,
        regressed: (pair: StagePair) =>
          measuredValue(pair.before, 'blacks')! < bands.crushedBlacks.hard &&
          measuredValue(pair.after, 'blacks')! >= bands.crushedBlacks.hard,
      },
      {
        source: 'contrast' as const,
        threshold: policy.contrastRegressionRatio,
        regressed: (pair: StagePair) =>
          measuredValue(pair.after, 'contrast')! <
          measuredValue(pair.before, 'contrast')! * policy.contrastRegressionRatio,
      },
    ]
    const unreadable = pairs.some((pair) => regressionChecks.some(({ source }) =>
      pair.before.dimensions[source].status !== 'measured' || pair.after.dimensions[source].status !== 'measured'))
    if (pairs.length === 0 || unreadable) {
      drafts.push(unavailableDimension(
        'matchRegression', COLOR_CRITIC_ACROSS_STAGES,
        'the same camera was not readable on both sides of the output transform, so nothing can be said about getting worse',
        measurementConfidence,
      ))
    } else {
      const regressed = pairs.flatMap((pair) => regressionChecks
        .filter((check) => check.regressed(pair))
        .map(({ source, threshold }) => ({ pair, source, threshold })))
      const severity = severityFor(regressed.length, bands.matchRegression, 'above')
      drafts.push({
        result: {
          dimension: 'matchRegression',
          status: 'measured',
          stage: COLOR_CRITIC_ACROSS_STAGES,
          value: regressed.length,
          unit: COLOR_CRITIC_UNITS.matchRegression,
          threshold: bands.matchRegression.hard,
          evaluatorIds: [criticId],
          evidenceRefs: unique(pairs.flatMap((pair) => [evidenceOf(pair.before, 'highlights'), evidenceOf(pair.after, 'highlights')].filter((ref): ref is string => ref !== null))),
          cameraIds: unique(pairs.map((pair) => pair.cameraId)),
          ...(severity ? { classification: 'technical-defect' as const } : {}),
        },
        issues: severity
          ? regressed.map(({ pair, source, threshold }) => issue(
              'matchRegression', severity, 'technical-defect', 'correctable-technical-defect',
              COLOR_CRITIC_ACROSS_STAGES, measuredValue(pair.after, source)!, threshold,
              Math.min(pair.before.confidence, pair.after.confidence),
              [evidenceOf(pair.after, source)!], pair.cameraId, pair.after.range,
            ))
          : [],
      })
    }
  }

  // --- confidence -----------------------------------------------------------
  const measuredCount = drafts.filter((draft) => draft.result.status === 'measured').length
  const unavailableCount = drafts.filter((draft) => draft.result.status === 'unavailable').length
  const coverage = measuredCount + unavailableCount === 0 ? 0 : measuredCount / (measuredCount + unavailableCount)
  const confidence = round6(Math.max(0, Math.min(1, measurementConfidence * coverage)))

  // --- the cause table ------------------------------------------------------
  const issues = drafts.flatMap((draft) => draft.issues)
  const hard = issues.filter((entry) => entry.severity === 'hard')
  // A dimension nobody could read is missing evidence, not a measured defect:
  // it must not be counted as one, or an unreadable `clipping` would reject a
  // render whose highlights were never looked at. It is counted whatever its
  // severity, though — an unread dimension is why a human is asked, and the
  // severity only says whether the verdict could have been reached without it.
  const evidenceMissing = issues.filter((entry) => entry.classification === 'insufficient-evidence')
  const defects = hard.filter((entry) => entry.classification !== 'insufficient-evidence')
  const irreversibleDimensions = new Set<string>(COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS)
  const correctableDimensions = new Set<string>(COLOR_CRITIC_CORRECTABLE_DIMENSIONS)
  const irreversible = defects.filter((entry) => irreversibleDimensions.has(entry.dimension))
  const correctable = defects.filter((entry) => correctableDimensions.has(entry.dimension))
  const proposed = correctable.length > 0
    ? proposeBoundedDeltas(comparisons, pairs, correctable, policy)
    : { deltas: [] as ColorCriticProposedDelta[], outOfBounds: false }

  // One predicate per cause, evaluated in COLOR_CRITIC_CAUSE_PRECEDENCE order:
  // the constant IS the algorithm, so the documented precedence and the code
  // cannot drift apart while the tests stay green. `no-defect` closes the
  // ladder and is total.
  const budgetSpent = correctionsApplied + 1 > COLOR_CRITIC_MAX_CORRECTION_ITERATIONS
  const unsure = confidence < COLOR_CRITIC_BOUNDED_CORRECTION_MINIMUM_CONFIDENCE
  const causeApplies: Readonly<Record<ColorCriticCause, () => boolean>> = {
    'irreversible-technical-defect': () => irreversible.length > 0,
    'evidence-unavailable': () => evidenceMissing.length > 0,
    'correction-budget-exhausted': () => correctable.length > 0 && budgetSpent,
    'correction-confidence-insufficient': () => correctable.length > 0 && unsure,
    'correction-out-of-bounds': () => correctable.length > 0 && proposed.outOfBounds,
    'correction-not-derivable': () => correctable.length > 0 && proposed.deltas.length === 0,
    'correctable-technical-defect': () => correctable.length > 0,
    'advisory-warning': () => issues.some((entry) => entry.severity === 'warning'),
    'documented-intent': () => drafts.some((draft) => draft.result.classification === 'documented-intent'),
    'no-defect': () => true,
  }
  const cause: ColorCriticCause = COLOR_CRITIC_CAUSE_PRECEDENCE.find((candidate) => causeApplies[candidate]())!
  const action = COLOR_CRITIC_CAUSE_ACTIONS[cause]

  // Which bytes were judged is read off the measurements, never declared by
  // the caller: a measurement is already bound to the exact file it decoded.
  const bytesOf = (measurements: readonly Readonly<CameraColorMeasurement>[]): readonly Readonly<ColorCriticBytes>[] =>
    Object.freeze([...new Map(measurements.map((measurement) =>
      [`${measurement.sourceAssetId}:${measurement.sourceSha256}`,
        Object.freeze({ artifactId: measurement.sourceAssetId, sha256: measurement.sourceSha256 })] as const,
    )).values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId)))
  const beforeBytes = bytesOf(before)
  const afterBytes = bytesOf(after)
  const bytesEvaluated = Object.freeze([...new Map(
    [...beforeBytes, ...afterBytes].map((bytes) => [`${bytes.artifactId}:${bytes.sha256}`, bytes]),
  ).values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId)))

  return createColorCriticReport({
    schemaVersion: COLOR_CRITIC_REPORT_SCHEMA_VERSION,
    reportId: input.reportId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    subject: input.subject,
    referenceCameraId,
    matchPlanId: matchPlan?.planId ?? null,
    matchPlanHash: matchPlan?.planHash ?? null,
    sections: [
      {
        stage: 'before-output-transform',
        bytesEvaluated: beforeBytes,
        measurementIds: before.map((measurement) => measurement.measurementId),
        measurements: before,
      },
      {
        stage: 'after-output-transform',
        bytesEvaluated: afterBytes,
        measurementIds: after.map((measurement) => measurement.measurementId),
        measurements: after,
      },
    ],
    stagePairs: pairs.map((pair) => ({
      cameraId: pair.cameraId,
      beforeMeasurementId: pair.before.measurementId,
      afterMeasurementId: pair.after.measurementId,
    })),
    bytesEvaluated,
    evaluators,
    dimensions: drafts.map((draft) => draft.result),
    issues,
    creativeIntent,
    intentBounds: {
      castAllowedDelta: creativeIntent.castAllowedDelta ?? null,
      maxDeclaredCastAllowance: policy.maxDeclaredCastAllowance,
    },
    cause,
    action,
    boundedCorrection: action === 'bounded-correction'
      ? {
          iteration: correctionsApplied + 1,
          maxIterations: COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
          proposedDeltas: proposed.deltas,
          reason: `bounded re-derivation of the match stage for ${unique(correctable.map((entry) => entry.dimension)).join(', ')}`,
        }
      : null,
    confidence,
    confidenceBand: colorCriticConfidenceBand(confidence),
    thresholds,
    evaluatedAt: input.evaluatedAt,
  })
}

/**
 * The deltas a bounded correction would apply, and whether any of them is
 * outside the policy limit. A correction the policy would not allow is never
 * quietly clamped into one that it does: the report says out-of-bounds and a
 * human decides.
 */
function proposeBoundedDeltas(
  comparisons: readonly CameraComparison[],
  pairs: readonly StagePair[],
  correctable: readonly Readonly<ColorCriticIssue>[],
  policy: ColorCriticPolicy,
): { deltas: ColorCriticProposedDelta[]; outOfBounds: boolean } {
  const dimensions = new Set(correctable.map((entry) => entry.dimension))
  const cameras = new Set(correctable.map((entry) => entry.cameraId).filter((id): id is string => id !== null))
  const deltas: ColorCriticProposedDelta[] = []
  let outOfBounds = false
  for (const cameraId of [...cameras].sort()) {
    const own = comparisons.filter((comparison) => comparison.cameraId === cameraId)
    const pair = pairs.find((entry) => entry.cameraId === cameraId) ?? null
    let exposureEv: number | null = null
    let whiteBalance: { redGain: number; greenGain: number; blueGain: number } | null = null
    let saturation: number | null = null
    if ((dimensions.has('exposureMismatch') || dimensions.has('localizedMismatch')) && own.length > 0) {
      const worst = own.reduce((left, right) =>
        Math.abs(right.exposureEv ?? 0) > Math.abs(left.exposureEv ?? 0) ? right : left)
      if (worst.exposureEv !== null) {
        exposureEv = round6(-worst.exposureEv)
        if (Math.abs(exposureEv) > policy.maxProposedExposureEv) outOfBounds = true
      }
    }
    if ((dimensions.has('whiteBalanceMismatch') || dimensions.has('cast')) && pair) {
      const rBefore = measuredComponent(pair.before, 'whiteBalance', 'rOverG')
      const rAfter = measuredComponent(pair.after, 'whiteBalance', 'rOverG')
      const bBefore = measuredComponent(pair.before, 'whiteBalance', 'bOverG')
      const bAfter = measuredComponent(pair.after, 'whiteBalance', 'bOverG')
      if (rBefore !== null && rAfter !== null && bBefore !== null && bAfter !== null && rAfter > 0 && bAfter > 0) {
        whiteBalance = {
          redGain: round6(rBefore / rAfter),
          greenGain: 1,
          blueGain: round6(bBefore / bAfter),
        }
        const low = 1 / policy.maxProposedGain
        for (const gain of [whiteBalance.redGain, whiteBalance.blueGain]) {
          if (gain < low || gain > policy.maxProposedGain) outOfBounds = true
        }
      }
    }
    if ((dimensions.has('saturationExcess') || dimensions.has('saturationDeficit')) && pair) {
      const beforeValue = measuredValue(pair.before, 'saturation')
      const afterValue = measuredValue(pair.after, 'saturation')
      if (beforeValue !== null && afterValue !== null && afterValue > 0) {
        saturation = round6(beforeValue / afterValue)
        if (saturation < policy.proposedSaturationRange[0] || saturation > policy.proposedSaturationRange[1]) outOfBounds = true
      }
    }
    if (exposureEv === null && whiteBalance === null && saturation === null) continue
    deltas.push(Object.freeze({ cameraId, exposureEv, whiteBalance, saturation }))
  }
  return { deltas, outOfBounds }
}
