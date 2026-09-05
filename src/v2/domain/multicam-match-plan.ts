import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  COLOR_TRANSFORM_ORDER,
  type ColorMetadata,
  type ColorTransform,
} from './color-and-export.ts'
import {
  assertCameraColorMeasurementIntegrity,
  COLOR_MEASUREMENT_COMPARABILITY_DIMENSIONS,
  COLOR_MEASUREMENT_MINIMUM_FRAMES,
  measuredComponent,
  measuredValue,
  type CameraColorMeasurement,
} from './color-measurement.ts'
import { assertDomain } from './errors.ts'
import {
  createTickInterval,
  intervalDuration,
  intervalIntersection,
  intervalsOverlap,
  type TickInterval,
} from './session-time.ts'

/**
 * Multicamera colour match (F4.013, FR-183).
 *
 * The plan turns per-camera measurements into `match`-stage transforms that
 * the existing ColorPlan already knows how to apply: one transform per camera
 * in `cameras[cameraId]`, the reference camera an explicit bypass, and range
 * overrides in `segments[clipId]`. It never invents a stage: the order
 * technical → match → creative-lut → output is fixed by `COLOR_TRANSFORM_ORDER`
 * and enforced by `createColorPlan`, `resolveColorPlan` and the FFmpeg
 * processor, so "match before the creative LUT" is true by construction. What
 * this module adds is the refusal to produce a match that would not be one:
 * a plan-derived transform of any other kind, or a match placed after the LUT
 * in a layer, is `COLOR_STAGE_VIOLATION`.
 *
 * Every number in a transform is derived from measurements. The caller
 * supplies ids, the reference camera and a fenced selection; it supplies no
 * deltas, no confidence and no approval.
 */

export const MULTICAM_MATCH_PLAN_SCHEMA_VERSION = 'multicam-match-plan/v1' as const
export const MATCH_PIPELINE_STAGE = 'match' as const
export const MATCH_PROVIDER = 'apollo-match' as const

/**
 * The `apollo-match` provider versions.
 *
 * v1 is what the FFmpeg processor accepts today (`ffmpeg-color-pipeline-
 * processor.ts:107-110`): an `eq` filter. v2 adds per-channel gains for white
 * balance, to be rendered as `colorchannelmixer=rr=<redGain>:gg=<greenGain>:
 * bb=<blueGain>` before the same `eq`. The version token is part of
 * `implementation.version`, so a v2 transform hashes differently from a v1
 * one and existing v1 compilations are untouched. Extending the processor
 * whitelist is integration work; this table is the contract it implements.
 */
export const MATCH_PROVIDER_VERSIONS = Object.freeze({
  v1: Object.freeze({
    version: 'v1',
    parameters: Object.freeze(['mode', 'brightness', 'contrast', 'saturation'] as const),
    filters: 'eq',
  }),
  v2: Object.freeze({
    version: 'v2',
    parameters: Object.freeze([
      'mode', 'brightness', 'contrast', 'saturation', 'redGain', 'greenGain', 'blueGain',
    ] as const),
    filters: 'colorchannelmixer,eq',
  }),
})
export type MatchProviderVersion = keyof typeof MATCH_PROVIDER_VERSIONS

/**
 * Safe bounds. brightness/contrast/saturation are the processor's own
 * (`ffmpeg-color-pipeline-processor.ts:123-127`); the gain bounds are the
 * proposal for v2 — a channel gain outside [0.5, 2] is not a balance, it is
 * a grade.
 */
export const MATCH_PARAMETER_BOUNDS = Object.freeze({
  brightness: Object.freeze([-1, 1] as const),
  contrast: Object.freeze([0.1, 3] as const),
  saturation: Object.freeze([0, 3] as const),
  gain: Object.freeze([0.5, 2] as const),
})

export const MATCH_ACTOR_KINDS = Object.freeze(['human', 'director', 'system'] as const)
export type MatchActorKind = (typeof MATCH_ACTOR_KINDS)[number]

export interface MatchActor {
  readonly kind: MatchActorKind
  readonly id: string
}

/**
 * Named limits. A correction beyond a limit is clamped to it and the plan
 * says so with `humanReviewRequired`; it is never applied silently at full
 * strength, and never silently dropped either.
 */
export const DEFAULT_MULTICAM_MATCH_POLICY = Object.freeze({
  minimumSampledFrames: COLOR_MEASUREMENT_MINIMUM_FRAMES,
  /** Gains within 1 ± this need no white-balance stage: v1 suffices. */
  whiteBalanceGainTolerance: 0.02,
  /** Largest per-channel gain applied without human review. */
  maxWhiteBalanceGain: 1.25,
  /** Largest additive luma offset (eq brightness units) applied without review. */
  maxBrightnessOffset: 0.2,
  /** |EV| beyond which the exposure delta is flagged for review. */
  maxExposureCorrectionEv: 1,
  contrastRange: Object.freeze([0.67, 1.5] as const),
  saturationRange: Object.freeze([0.67, 1.5] as const),
  /** Display gamma used to express an encoded luma ratio as stops. */
  exposureGamma: 2.2,
  /** Dispersion (max − min across range pairs) that drives confidence to zero. */
  exposureDispersionEvScale: 0.5,
  gainDispersionScale: 0.1,
  /** One range pair cannot estimate dispersion; it cannot claim high confidence. */
  singleRangeConfidenceCap: 0.8,
})
export type MulticamMatchPolicy = typeof DEFAULT_MULTICAM_MATCH_POLICY

export interface ReferenceCameraSelection {
  readonly selectedBy: Readonly<MatchActor>
  readonly selectedAt: string
  /** `<sessionId>:v<sessionVersion>` — the session the selector was looking at. */
  readonly baseVersionId: string
  readonly baseHash: string
}

export interface MatchDeltas {
  /** Camera relative to reference, in stops; positive = camera brighter. */
  readonly exposureEv: number | null
  /** Gains that bring the camera's channel ratios onto the reference's. */
  readonly whiteBalance: Readonly<{ redGain: number; greenGain: number; blueGain: number }> | null
  /** reference std / camera std. */
  readonly contrast: number | null
  /** reference chroma / camera chroma. */
  readonly saturation: number | null
}

export interface CameraMatchTransform {
  readonly cameraId: string
  readonly transform: Readonly<ColorTransform>
  readonly derivedFrom: readonly string[]
  readonly deltas: Readonly<MatchDeltas>
  readonly confidence: number
  readonly rangePairs: number
}

export interface MatchRangeOverride {
  readonly overrideId: string
  readonly cameraId: string
  readonly segmentId?: string
  readonly range?: Readonly<TickInterval>
  readonly transform: Readonly<ColorTransform>
  readonly reason: string
  readonly actor: Readonly<MatchActor>
}

export interface NonComparableRange {
  readonly cameraId: string
  readonly measurementId: string
  readonly range: Readonly<TickInterval>
  readonly reason: string
}

export interface MatchPlanIssue {
  readonly code: string
  readonly cameraId: string | null
  readonly message: string
  readonly humanReviewRequired: boolean
}

export interface MatchPlanLineage {
  readonly colorProbeIds: readonly string[]
  readonly compilationIds?: readonly string[]
  readonly directionHash?: string
}

export interface MulticamMatchPlan {
  readonly schemaVersion: typeof MULTICAM_MATCH_PLAN_SCHEMA_VERSION
  readonly planId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly sessionId: string
  readonly sessionVersion: number
  readonly referenceEpoch: number
  readonly referenceCameraId: string
  readonly referenceCameraSelection: Readonly<ReferenceCameraSelection>
  readonly measurements: readonly Readonly<CameraColorMeasurement>[]
  readonly cameraTransforms: readonly Readonly<CameraMatchTransform>[]
  readonly rangeOverrides: readonly Readonly<MatchRangeOverride>[]
  readonly confidence: number
  readonly issues: readonly Readonly<MatchPlanIssue>[]
  readonly nonComparableRanges: readonly Readonly<NonComparableRange>[]
  readonly humanReviewRequired: boolean
  readonly pipelineStage: typeof MATCH_PIPELINE_STAGE
  readonly lineage: Readonly<MatchPlanLineage>
  /** What a reference change invalidates: only plans that depend on these. */
  readonly dependsOn: Readonly<{ measurementIds: readonly string[]; referenceCameraId: string }>
  /** The plan this one replaces, if it was re-derived or amended. */
  readonly supersedes: string | null
  readonly createdAt: string
  readonly planHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const EPSILON = 1e-4

function assertId(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

function assertHash(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && HASH.test(value), 'INVALID_ARGUMENT', `${field} must be a lowercase SHA-256`)
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

function assertUnitInterval(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be within [0, 1]`,
  )
  return value
}

function assertActor(value: Readonly<MatchActor> | undefined, field: string): Readonly<MatchActor> {
  assertDomain(value && MATCH_ACTOR_KINDS.includes(value.kind), 'INVALID_ARGUMENT', `${field}.kind is invalid`)
  return Object.freeze({ kind: value.kind, id: assertId(value.id, `${field}.id`) })
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

function clamp(value: number, [low, high]: readonly [number, number]): number {
  return Math.min(high, Math.max(low, value))
}

function sameMetadata(left: Readonly<ColorMetadata>, right: Readonly<ColorMetadata>): boolean {
  return calculateCanonicalHash(left) === calculateCanonicalHash(right)
}

/** Ticks as decimal text, structure otherwise untouched; what gets hashed. */
function ticksAsText(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(ticksAsText)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, ticksAsText(nested)]))
  }
  return value
}

// ---------------------------------------------------------------------------
// Match-stage transforms
// ---------------------------------------------------------------------------

function transformId(cameraId: string, segmentId?: string): string {
  const id = segmentId ? `match-${cameraId}-${segmentId}` : `match-${cameraId}`
  return assertToken(id, 'match transform id')
}

function implementation(version: MatchProviderVersion, parameters: Readonly<Record<string, string | number | boolean>>) {
  const sorted = Object.freeze(Object.fromEntries(
    Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)),
  ))
  return Object.freeze({
    provider: MATCH_PROVIDER,
    version: MATCH_PROVIDER_VERSIONS[version].version,
    parameters: sorted,
    parametersHash: calculateCanonicalHash(sorted),
  })
}

/** The reference camera's transform: an explicit, hashed no-op. */
export function createMatchBypassTransform(input: {
  cameraId: string
  metadata: Readonly<ColorMetadata>
  segmentId?: string
}): Readonly<ColorTransform> {
  return assertMatchStageTransform(Object.freeze({
    id: transformId(input.cameraId, input.segmentId),
    kind: MATCH_PIPELINE_STAGE,
    version: 'v1',
    enabled: false,
    input: input.metadata,
    output: input.metadata,
    implementation: implementation('v1', { mode: 'bypass' }),
  }))
}

export interface MatchAdjustParameters {
  readonly brightness: number
  readonly contrast: number
  readonly saturation: number
  readonly gains?: Readonly<{ redGain: number; greenGain: number; blueGain: number }>
}

/**
 * An enabled match. v1 when the three `eq` terms suffice; v2 as soon as a
 * channel gain is present. Values are rounded to six decimals so the same
 * measurement always hashes to the same transform.
 */
export function createMatchAdjustTransform(input: {
  cameraId: string
  metadata: Readonly<ColorMetadata>
  parameters: Readonly<MatchAdjustParameters>
  segmentId?: string
}): Readonly<ColorTransform> {
  const base = {
    mode: 'adjust',
    brightness: round6(input.parameters.brightness),
    contrast: round6(input.parameters.contrast),
    saturation: round6(input.parameters.saturation),
  }
  const gains = input.parameters.gains
  const version: MatchProviderVersion = gains ? 'v2' : 'v1'
  const parameters = gains
    ? { ...base, redGain: round6(gains.redGain), greenGain: round6(gains.greenGain), blueGain: round6(gains.blueGain) }
    : base
  return assertMatchStageTransform(Object.freeze({
    id: transformId(input.cameraId, input.segmentId),
    kind: MATCH_PIPELINE_STAGE,
    version: 'v1',
    enabled: true,
    input: input.metadata,
    output: input.metadata,
    implementation: implementation(version, parameters),
  }))
}

function providerVersionOf(transform: Readonly<ColorTransform>): MatchProviderVersion {
  const entry = (Object.keys(MATCH_PROVIDER_VERSIONS) as MatchProviderVersion[])
    .find((key) => MATCH_PROVIDER_VERSIONS[key].version === transform.implementation.version)
  assertDomain(entry !== undefined, 'INVALID_ARGUMENT', `apollo-match version ${transform.implementation.version} is unknown`)
  return entry
}

/**
 * A transform this plan is allowed to carry. Anything that is not a `match`
 * is a stage violation, not an argument error: the plan exists to place the
 * camera correction before the creative LUT, and a `creative-lut` or `output`
 * transform inside it would be that very mistake with a friendlier name.
 */
export function assertMatchStageTransform(transform: Readonly<ColorTransform>): Readonly<ColorTransform> {
  assertDomain(
    transform && transform.kind === MATCH_PIPELINE_STAGE,
    'COLOR_STAGE_VIOLATION',
    `a multicam match transform must be a ${MATCH_PIPELINE_STAGE} stage, received ${String(transform?.kind)}`,
    { kind: transform?.kind ?? null },
  )
  assertDomain(
    transform.implementation.provider === MATCH_PROVIDER,
    'INVALID_ARGUMENT',
    `match transform ${transform.id} must use ${MATCH_PROVIDER}`,
  )
  const version = providerVersionOf(transform)
  const allowed = MATCH_PROVIDER_VERSIONS[version].parameters as readonly string[]
  const parameters = transform.implementation.parameters
  assertDomain(
    Object.keys(parameters).every((key) => allowed.includes(key)),
    'INVALID_ARGUMENT',
    `match transform ${transform.id} carries parameters outside apollo-match ${version}`,
  )
  assertDomain(
    calculateCanonicalHash(parameters) === transform.implementation.parametersHash,
    'INVALID_ARGUMENT',
    `match transform ${transform.id} parametersHash does not match its parameters`,
  )
  assertDomain(
    sameMetadata(transform.input, transform.output),
    'INVALID_ARGUMENT',
    `match transform ${transform.id} must not change colorimetry`,
  )
  if (!transform.enabled) {
    assertDomain(parameters.mode === 'bypass', 'INVALID_ARGUMENT', `disabled match ${transform.id} must be an explicit bypass`)
    return transform
  }
  assertDomain(parameters.mode === 'adjust', 'INVALID_ARGUMENT', `enabled match ${transform.id} must declare adjust mode`)
  const brightness = Number(parameters.brightness ?? 0)
  const contrast = Number(parameters.contrast ?? 1)
  const saturation = Number(parameters.saturation ?? 1)
  assertDomain(
    Number.isFinite(brightness) && brightness >= MATCH_PARAMETER_BOUNDS.brightness[0] && brightness <= MATCH_PARAMETER_BOUNDS.brightness[1] &&
      Number.isFinite(contrast) && contrast >= MATCH_PARAMETER_BOUNDS.contrast[0] && contrast <= MATCH_PARAMETER_BOUNDS.contrast[1] &&
      Number.isFinite(saturation) && saturation >= MATCH_PARAMETER_BOUNDS.saturation[0] && saturation <= MATCH_PARAMETER_BOUNDS.saturation[1],
    'INVALID_ARGUMENT',
    `match transform ${transform.id} parameters are outside safe bounds`,
  )
  if (version === 'v2') {
    for (const key of ['redGain', 'greenGain', 'blueGain'] as const) {
      const gain = Number(parameters[key])
      assertDomain(
        Number.isFinite(gain) && gain >= MATCH_PARAMETER_BOUNDS.gain[0] && gain <= MATCH_PARAMETER_BOUNDS.gain[1],
        'INVALID_ARGUMENT',
        `match transform ${transform.id} ${key} is outside safe bounds`,
      )
    }
  }
  return transform
}

/**
 * A layer, in application order, may not apply a match after the creative LUT
 * or the output transform. `resolveColorPlan` re-orders by kind and would hide
 * the mistake; this refuses it where it was made.
 */
export function assertMatchStagePosition(transforms: readonly Readonly<ColorTransform>[]): void {
  const matchIndex = COLOR_TRANSFORM_ORDER.indexOf(MATCH_PIPELINE_STAGE)
  let latestStageSeen = -1
  for (const [index, transform] of transforms.entries()) {
    const stage = COLOR_TRANSFORM_ORDER.indexOf(transform.kind)
    assertDomain(stage >= 0, 'INVALID_ARGUMENT', `transform ${index} has an unknown stage kind`)
    if (transform.kind === MATCH_PIPELINE_STAGE) {
      assertDomain(
        latestStageSeen <= matchIndex,
        'COLOR_STAGE_VIOLATION',
        `match transform ${transform.id} is positioned after ${COLOR_TRANSFORM_ORDER[latestStageSeen]}; camera matching must precede the creative LUT`,
        { position: index, after: COLOR_TRANSFORM_ORDER[latestStageSeen] },
      )
    }
    latestStageSeen = Math.max(latestStageSeen, stage)
  }
}

// ---------------------------------------------------------------------------
// Plan construction and integrity
// ---------------------------------------------------------------------------

export type MulticamMatchPlanContent = Omit<MulticamMatchPlan, 'planHash'>

export function calculateMulticamMatchPlanHash(content: Readonly<MulticamMatchPlanContent>): string {
  return calculateCanonicalHash(ticksAsText(content))
}

function normalizedSelection(
  value: Readonly<ReferenceCameraSelection>,
  sessionId: string,
  sessionVersion: number,
): Readonly<ReferenceCameraSelection> {
  assertDomain(value && typeof value === 'object', 'INVALID_ARGUMENT', 'referenceCameraSelection is required')
  const expectedBase = `${sessionId}:v${sessionVersion}`
  assertDomain(
    value.baseVersionId === expectedBase,
    'INVALID_ARGUMENT',
    `referenceCameraSelection.baseVersionId must name the session version the plan derives from (${expectedBase})`,
    { expected: expectedBase, received: value.baseVersionId },
  )
  return Object.freeze({
    selectedBy: assertActor(value.selectedBy, 'referenceCameraSelection.selectedBy'),
    selectedAt: assertInstant(value.selectedAt, 'referenceCameraSelection.selectedAt'),
    baseVersionId: value.baseVersionId,
    baseHash: assertHash(value.baseHash, 'referenceCameraSelection.baseHash'),
  })
}

function normalizedLineage(value: Readonly<MatchPlanLineage>): Readonly<MatchPlanLineage> {
  assertDomain(value && Array.isArray(value.colorProbeIds), 'INVALID_ARGUMENT', 'lineage.colorProbeIds is required')
  return Object.freeze({
    colorProbeIds: Object.freeze(value.colorProbeIds.map((id, index) => assertId(id, `lineage.colorProbeIds[${index}]`))),
    ...(value.compilationIds
      ? { compilationIds: Object.freeze(value.compilationIds.map((id, index) => assertId(id, `lineage.compilationIds[${index}]`))) }
      : {}),
    ...(value.directionHash !== undefined ? { directionHash: assertHash(value.directionHash, 'lineage.directionHash') } : {}),
  })
}

function normalizedOverride(value: Readonly<MatchRangeOverride>, index: number): Readonly<MatchRangeOverride> {
  const field = `rangeOverrides[${index}]`
  assertDomain(
    (value.segmentId === undefined) !== (value.range === undefined),
    'INVALID_ARGUMENT',
    `${field} must target exactly one of segmentId or range`,
  )
  assertDomain(
    typeof value.reason === 'string' && value.reason.trim().length >= 3,
    'INVALID_ARGUMENT',
    `${field}.reason is required`,
  )
  return Object.freeze({
    overrideId: assertId(value.overrideId, `${field}.overrideId`),
    cameraId: assertToken(value.cameraId, `${field}.cameraId`),
    ...(value.segmentId !== undefined ? { segmentId: assertToken(value.segmentId, `${field}.segmentId`) } : {}),
    ...(value.range !== undefined ? { range: createTickInterval(value.range.start, value.range.end) } : {}),
    transform: assertMatchStageTransform(value.transform),
    reason: value.reason,
    actor: assertActor(value.actor, `${field}.actor`),
  })
}

/**
 * Assemble and validate a plan from its parts. Used by derivation and by the
 * override amendment; not a public constructor for hand-written transforms —
 * the numbers in a plan come from measurements or from an override that names
 * its actor and reason.
 */
function createMulticamMatchPlan(content: Readonly<MulticamMatchPlanContent>): Readonly<MulticamMatchPlan> {
  assertDomain(
    content.pipelineStage === MATCH_PIPELINE_STAGE,
    'COLOR_STAGE_VIOLATION',
    `a multicam match plan is a ${MATCH_PIPELINE_STAGE}-stage plan; received ${String(content.pipelineStage)}`,
  )
  assertDomain(
    Number.isSafeInteger(content.sessionVersion) && content.sessionVersion >= 1 &&
      Number.isSafeInteger(content.referenceEpoch) && content.referenceEpoch >= 0,
    'INVALID_ARGUMENT',
    'sessionVersion must be a positive integer and referenceEpoch a non-negative integer',
  )
  const sessionId = assertId(content.sessionId, 'sessionId')
  const measurements = Object.freeze(content.measurements.map((measurement) => assertCameraColorMeasurementIntegrity(measurement)))
  const measurementIds = new Set(measurements.map((measurement) => measurement.measurementId))
  assertDomain(measurementIds.size === measurements.length, 'INVALID_ARGUMENT', 'measurementIds must be unique within a plan')
  const referenceCameraId = assertToken(content.referenceCameraId, 'referenceCameraId')
  const cameraTransforms = Object.freeze(content.cameraTransforms.map((entry, index) => {
    const field = `cameraTransforms[${index}]`
    assertDomain(entry.cameraId !== referenceCameraId, 'INVALID_ARGUMENT', `${field} must not correct the reference camera`)
    for (const id of entry.derivedFrom) {
      assertDomain(measurementIds.has(id), 'INVALID_ARGUMENT', `${field}.derivedFrom names a measurement outside the plan`)
    }
    return Object.freeze({
      cameraId: assertToken(entry.cameraId, `${field}.cameraId`),
      transform: assertMatchStageTransform(entry.transform),
      derivedFrom: Object.freeze([...entry.derivedFrom]),
      deltas: Object.freeze({
        exposureEv: entry.deltas.exposureEv,
        whiteBalance: entry.deltas.whiteBalance ? Object.freeze({ ...entry.deltas.whiteBalance }) : null,
        contrast: entry.deltas.contrast,
        saturation: entry.deltas.saturation,
      }),
      confidence: assertUnitInterval(entry.confidence, `${field}.confidence`),
      rangePairs: entry.rangePairs,
    })
  }))
  assertDomain(
    new Set(cameraTransforms.map((entry) => entry.cameraId)).size === cameraTransforms.length,
    'INVALID_ARGUMENT',
    'a camera is corrected at most once per plan',
  )
  const knownCameras = new Set([referenceCameraId, ...cameraTransforms.map((entry) => entry.cameraId)])
  const rangeOverrides = Object.freeze(content.rangeOverrides.map((override, index) => {
    const normalized = normalizedOverride(override, index)
    assertDomain(
      knownCameras.has(normalized.cameraId),
      'INVALID_ARGUMENT',
      `rangeOverrides[${index}] targets camera ${normalized.cameraId}, which the plan does not know`,
    )
    return normalized
  }))
  assertDomain(
    new Set(rangeOverrides.map((override) => override.overrideId)).size === rangeOverrides.length,
    'INVALID_ARGUMENT',
    'overrideIds must be unique within a plan',
  )
  const body: MulticamMatchPlanContent = Object.freeze({
    schemaVersion: MULTICAM_MATCH_PLAN_SCHEMA_VERSION,
    planId: assertId(content.planId, 'planId'),
    workspaceId: assertId(content.workspaceId, 'workspaceId'),
    projectId: assertId(content.projectId, 'projectId'),
    sessionId,
    sessionVersion: content.sessionVersion,
    referenceEpoch: content.referenceEpoch,
    referenceCameraId,
    referenceCameraSelection: normalizedSelection(content.referenceCameraSelection, sessionId, content.sessionVersion),
    measurements,
    cameraTransforms,
    rangeOverrides,
    confidence: assertUnitInterval(content.confidence, 'confidence'),
    issues: Object.freeze(content.issues.map((issue) => Object.freeze({
      code: assertToken(issue.code, 'issue.code'),
      cameraId: issue.cameraId,
      message: issue.message,
      humanReviewRequired: issue.humanReviewRequired === true,
    }))),
    nonComparableRanges: Object.freeze(content.nonComparableRanges.map((entry) => Object.freeze({
      cameraId: assertToken(entry.cameraId, 'nonComparableRanges.cameraId'),
      measurementId: assertId(entry.measurementId, 'nonComparableRanges.measurementId'),
      range: createTickInterval(entry.range.start, entry.range.end),
      reason: entry.reason,
    }))),
    humanReviewRequired: content.humanReviewRequired === true,
    pipelineStage: MATCH_PIPELINE_STAGE,
    lineage: normalizedLineage(content.lineage),
    dependsOn: Object.freeze({
      measurementIds: Object.freeze([...content.dependsOn.measurementIds]),
      referenceCameraId: assertToken(content.dependsOn.referenceCameraId, 'dependsOn.referenceCameraId'),
    }),
    supersedes: content.supersedes === null ? null : assertId(content.supersedes, 'supersedes'),
    createdAt: assertInstant(content.createdAt, 'createdAt'),
  })
  return Object.freeze({ ...body, planHash: calculateMulticamMatchPlanHash(body) })
}

/**
 * Re-verify a plan from storage: the hash, every measurement's hash, and the
 * stage rule. A plan whose transforms were edited underneath it, or which
 * somehow carries a non-match transform, is refused before anything reads it.
 */
export function assertMulticamMatchPlanIntegrity(plan: Readonly<MulticamMatchPlan>): Readonly<MulticamMatchPlan> {
  assertDomain(
    plan.schemaVersion === MULTICAM_MATCH_PLAN_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored multicam match plan schema is unknown',
  )
  const { planHash, ...content } = plan
  assertDomain(
    calculateMulticamMatchPlanHash(content) === planHash,
    'PERSISTENCE_CONFLICT',
    'multicam match plan hash does not match its stored content',
  )
  assertDomain(plan.pipelineStage === MATCH_PIPELINE_STAGE, 'COLOR_STAGE_VIOLATION', 'stored plan is not a match-stage plan')
  for (const measurement of plan.measurements) assertCameraColorMeasurementIntegrity(measurement)
  for (const entry of plan.cameraTransforms) assertMatchStageTransform(entry.transform)
  for (const override of plan.rangeOverrides) assertMatchStageTransform(override.transform)
  return plan
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

interface PairDelta {
  weight: number
  exposureEv: number
  brightness: number
  redGain: number
  blueGain: number
  contrast: number
  saturation: number
  measurementId: string
  referenceMeasurementId: string
}

function ratio(numerator: number, denominator: number): number {
  return Math.max(numerator, EPSILON) / Math.max(denominator, EPSILON)
}

function pairDelta(
  camera: Readonly<CameraColorMeasurement>,
  reference: Readonly<CameraColorMeasurement>,
  policy: MulticamMatchPolicy,
): PairDelta {
  const overlap = intervalIntersection(camera.range, reference.range)!
  const yCamera = measuredValue(camera, 'exposure')!
  const yReference = measuredValue(reference, 'exposure')!
  const rOverGCamera = measuredComponent(camera, 'whiteBalance', 'rOverG')
  const rOverGReference = measuredComponent(reference, 'whiteBalance', 'rOverG')
  const bOverGCamera = measuredComponent(camera, 'whiteBalance', 'bOverG')
  const bOverGReference = measuredComponent(reference, 'whiteBalance', 'bOverG')
  assertDomain(
    rOverGCamera !== null && rOverGReference !== null && bOverGCamera !== null && bOverGReference !== null,
    'COLOR_MEASUREMENT_INSUFFICIENT',
    'white balance measurements must carry rOverG and bOverG components',
    { cameraId: camera.cameraId, measurementId: camera.measurementId },
  )
  return {
    weight: Number(intervalDuration(overlap)),
    exposureEv: policy.exposureGamma * Math.log2(ratio(yCamera, yReference)),
    brightness: yReference - yCamera,
    redGain: ratio(rOverGReference, rOverGCamera),
    blueGain: ratio(bOverGReference, bOverGCamera),
    contrast: ratio(measuredValue(reference, 'contrast')!, measuredValue(camera, 'contrast')!),
    saturation: ratio(measuredValue(reference, 'saturation')!, measuredValue(camera, 'saturation')!),
    measurementId: camera.measurementId,
    referenceMeasurementId: reference.measurementId,
  }
}

function weightedMean(pairs: readonly PairDelta[], pick: (pair: PairDelta) => number): number {
  const total = pairs.reduce((sum, pair) => sum + pair.weight, 0)
  return pairs.reduce((sum, pair) => sum + pick(pair) * pair.weight, 0) / total
}

function spread(pairs: readonly PairDelta[], pick: (pair: PairDelta) => number): number {
  const values = pairs.map(pick)
  return Math.max(...values) - Math.min(...values)
}

function assertMeasurementSufficient(measurement: Readonly<CameraColorMeasurement>, policy: MulticamMatchPolicy): void {
  assertDomain(
    measurement.sampledFrames >= policy.minimumSampledFrames,
    'COLOR_MEASUREMENT_INSUFFICIENT',
    `camera ${measurement.cameraId} measured ${measurement.sampledFrames} frames; at least ${policy.minimumSampledFrames} are needed`,
    { cameraId: measurement.cameraId, measurementId: measurement.measurementId, sampledFrames: measurement.sampledFrames },
  )
  for (const dimension of COLOR_MEASUREMENT_COMPARABILITY_DIMENSIONS) {
    const result = measurement.dimensions[dimension]
    assertDomain(
      result.status === 'measured',
      'COLOR_MEASUREMENT_INSUFFICIENT',
      `camera ${measurement.cameraId} has ${dimension} ${result.status}; a match cannot be derived from it`,
      { cameraId: measurement.cameraId, measurementId: measurement.measurementId, dimension, status: result.status },
    )
  }
}

export interface DeriveMulticamMatchPlanInput {
  planId: string
  workspaceId: string
  projectId: string
  sessionId: string
  sessionVersion: number
  referenceEpoch: number
  referenceCameraId: string
  referenceCameraSelection: Readonly<ReferenceCameraSelection>
  measurements: readonly Readonly<CameraColorMeasurement>[]
  lineage: Readonly<MatchPlanLineage>
  createdAt: string
  policy?: Partial<MulticamMatchPolicy>
  /** The plan this derivation replaces (a reference change or re-measurement). */
  supersedes?: Readonly<MulticamMatchPlan>
}

/**
 * Derive the plan.
 *
 * Every camera's deltas are computed against the reference on ranges that
 * overlap in session time, pair by pair, then averaged weighted by overlap.
 * Confidence is what the pairs agree on: it falls with dispersion between
 * ranges and can never be high from a single pair. Any measurement that is
 * not comparable — wrong colourimetry, HDR, too few frames, a required
 * dimension not measured — fails the derivation with the code that names
 * the remedy. No partial plan is produced.
 */
export function deriveMulticamMatchPlan(input: DeriveMulticamMatchPlanInput): Readonly<MulticamMatchPlan> {
  const policy: MulticamMatchPolicy = Object.freeze({ ...DEFAULT_MULTICAM_MATCH_POLICY, ...(input.policy ?? {}) })
  const referenceCameraId = assertToken(input.referenceCameraId, 'referenceCameraId')
  assertDomain(
    Array.isArray(input.measurements) && input.measurements.length >= 2,
    'INVALID_ARGUMENT',
    'a match plan needs measurements for the reference and at least one other camera',
  )
  const measurements = input.measurements.map((measurement) => assertCameraColorMeasurementIntegrity(measurement))
  for (const measurement of measurements) {
    assertDomain(
      measurement.sessionId === null || measurement.sessionId === input.sessionId,
      'INVALID_ARGUMENT',
      `measurement ${measurement.measurementId} belongs to session ${measurement.sessionId}, not ${input.sessionId}`,
    )
  }
  const referenceMeasurements = measurements.filter((measurement) => measurement.cameraId === referenceCameraId)
  assertDomain(
    referenceMeasurements.length > 0,
    'COLOR_REFERENCE_UNAVAILABLE',
    `reference camera ${referenceCameraId} has no measurement; nothing can be matched to it`,
    { referenceCameraId, measuredCameras: [...new Set(measurements.map((measurement) => measurement.cameraId))].sort() },
  )
  // HDR is refused before colourimetry is compared: a PQ source differs in
  // transfer as well, and "incomparable" would hide the real reason — there
  // is no tone-map in the pipeline to stand behind any comparison at all.
  for (const measurement of measurements) {
    assertDomain(
      measurement.technical.hdrMode === 'sdr',
      'COLOR_HDR_SDR_UNSUPPORTED',
      `camera ${measurement.cameraId} is ${measurement.technical.hdrMode}; no tone-map exists, so it cannot be matched to an SDR reference`,
      { cameraId: measurement.cameraId, measurementId: measurement.measurementId, hdrMode: measurement.technical.hdrMode },
    )
  }
  const workingMetadata = referenceMeasurements[0]!.technical.metadata
  for (const measurement of measurements) {
    assertDomain(
      sameMetadata(measurement.technical.metadata, workingMetadata),
      'COLOR_SOURCES_INCOMPARABLE',
      `camera ${measurement.cameraId} was measured in a different colourimetry than the reference; measure the technically normalized intermediate instead`,
      { cameraId: measurement.cameraId, expected: workingMetadata, received: measurement.technical.metadata },
    )
    assertMeasurementSufficient(measurement, policy)
  }

  const cameraIds = [...new Set(measurements.map((measurement) => measurement.cameraId))]
    .filter((cameraId) => cameraId !== referenceCameraId)
    .sort()
  assertDomain(cameraIds.length >= 1, 'INVALID_ARGUMENT', 'a match plan needs at least one camera besides the reference')

  const issues: MatchPlanIssue[] = []
  const nonComparableRanges: NonComparableRange[] = []
  const cameraTransforms: CameraMatchTransform[] = []

  for (const cameraId of cameraIds) {
    const own = measurements.filter((measurement) => measurement.cameraId === cameraId)
    const pairs: PairDelta[] = []
    for (const measurement of own) {
      const overlapping = referenceMeasurements.filter((reference) => intervalsOverlap(reference.range, measurement.range))
      if (overlapping.length === 0) {
        nonComparableRanges.push(Object.freeze({
          cameraId,
          measurementId: measurement.measurementId,
          range: measurement.range,
          reason: 'no-overlapping-reference-range',
        }))
        continue
      }
      for (const reference of overlapping) pairs.push(pairDelta(measurement, reference, policy))
    }
    assertDomain(
      pairs.length > 0,
      'COLOR_RANGES_NOT_COMPARABLE',
      `camera ${cameraId} was measured on ranges that never overlap the reference camera's; the two describe different moments`,
      { cameraId, ranges: own.map((measurement) => ({ start: measurement.range.start.toString(), end: measurement.range.end.toString() })) },
    )

    const exposureEv = weightedMean(pairs, (pair) => pair.exposureEv)
    const brightnessRequested = weightedMean(pairs, (pair) => pair.brightness)
    const redGainRequested = weightedMean(pairs, (pair) => pair.redGain)
    const blueGainRequested = weightedMean(pairs, (pair) => pair.blueGain)
    const contrastRequested = weightedMean(pairs, (pair) => pair.contrast)
    const saturationRequested = weightedMean(pairs, (pair) => pair.saturation)

    const gainBounds = [1 / policy.maxWhiteBalanceGain, policy.maxWhiteBalanceGain] as const
    const brightness = clamp(brightnessRequested, [-policy.maxBrightnessOffset, policy.maxBrightnessOffset])
    const redGain = clamp(redGainRequested, gainBounds)
    const blueGain = clamp(blueGainRequested, gainBounds)
    const contrast = clamp(contrastRequested, policy.contrastRange)
    const saturation = clamp(saturationRequested, policy.saturationRange)

    const limited: string[] = []
    if (brightness !== brightnessRequested) limited.push('brightness')
    if (redGain !== redGainRequested) limited.push('redGain')
    if (blueGain !== blueGainRequested) limited.push('blueGain')
    if (contrast !== contrastRequested) limited.push('contrast')
    if (saturation !== saturationRequested) limited.push('saturation')
    for (const parameter of limited) {
      issues.push(Object.freeze({
        code: 'correction-limited',
        cameraId,
        message: `${parameter} for camera ${cameraId} exceeds the policy limit and was clamped; a human must decide whether to go further`,
        humanReviewRequired: true,
      }))
    }
    if (Math.abs(exposureEv) > policy.maxExposureCorrectionEv) {
      issues.push(Object.freeze({
        code: 'exposure-delta-exceeds-policy',
        cameraId,
        message: `camera ${cameraId} is ${exposureEv.toFixed(2)} EV from the reference; beyond ${policy.maxExposureCorrectionEv} EV an additive offset is not a match`,
        humanReviewRequired: true,
      }))
    }

    const needsWhiteBalance =
      Math.abs(redGain - 1) > policy.whiteBalanceGainTolerance ||
      Math.abs(blueGain - 1) > policy.whiteBalanceGainTolerance
    const gains = needsWhiteBalance ? { redGain, greenGain: 1, blueGain } : undefined

    const exposureDispersion = spread(pairs, (pair) => pair.exposureEv)
    const gainDispersion = Math.max(spread(pairs, (pair) => pair.redGain), spread(pairs, (pair) => pair.blueGain))
    const measurementConfidence = Math.min(...own.map((measurement) => measurement.confidence), ...referenceMeasurements.map((measurement) => measurement.confidence))
    let confidence = measurementConfidence *
      (1 - Math.min(1, exposureDispersion / policy.exposureDispersionEvScale)) *
      (1 - Math.min(1, gainDispersion / policy.gainDispersionScale))
    if (pairs.length === 1) confidence = Math.min(confidence, policy.singleRangeConfidenceCap)
    if (nonComparableRanges.some((entry) => entry.cameraId === cameraId)) {
      issues.push(Object.freeze({
        code: 'range-not-comparable',
        cameraId,
        message: `camera ${cameraId} has measured ranges with no reference counterpart; they did not contribute to the match`,
        humanReviewRequired: false,
      }))
    }

    cameraTransforms.push(Object.freeze({
      cameraId,
      transform: createMatchAdjustTransform({
        cameraId,
        metadata: workingMetadata,
        parameters: { brightness, contrast, saturation, gains },
      }),
      derivedFrom: Object.freeze([...new Set(pairs.flatMap((pair) => [pair.measurementId, pair.referenceMeasurementId]))].sort()),
      deltas: Object.freeze({
        exposureEv: round6(exposureEv),
        whiteBalance: Object.freeze({ redGain: round6(redGainRequested), greenGain: 1, blueGain: round6(blueGainRequested) }),
        contrast: round6(contrastRequested),
        saturation: round6(saturationRequested),
      }),
      confidence: round6(Math.max(0, Math.min(1, confidence))),
      rangePairs: pairs.length,
    }))
  }

  let supersedes: string | null = null
  if (input.supersedes) {
    const previous = assertMulticamMatchPlanIntegrity(input.supersedes)
    assertDomain(
      previous.sessionId === input.sessionId && previous.workspaceId === input.workspaceId && previous.projectId === input.projectId,
      'INVALID_ARGUMENT',
      'a plan can only supersede a plan of the same session',
    )
    assertDomain(
      input.sessionVersion >= previous.sessionVersion,
      'VERSION_CONFLICT',
      'a plan cannot supersede one derived from a newer session version',
      { currentVersion: previous.sessionVersion, currentHash: previous.planHash },
    )
    supersedes = previous.planId
  }

  return createMulticamMatchPlan({
    schemaVersion: MULTICAM_MATCH_PLAN_SCHEMA_VERSION,
    planId: input.planId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    sessionVersion: input.sessionVersion,
    referenceEpoch: input.referenceEpoch,
    referenceCameraId,
    referenceCameraSelection: input.referenceCameraSelection,
    measurements,
    cameraTransforms,
    rangeOverrides: [],
    confidence: round6(Math.min(...cameraTransforms.map((entry) => entry.confidence))),
    issues,
    nonComparableRanges,
    humanReviewRequired: issues.some((issue) => issue.humanReviewRequired),
    pipelineStage: MATCH_PIPELINE_STAGE,
    lineage: input.lineage,
    dependsOn: { measurementIds: measurements.map((measurement) => measurement.measurementId).sort(), referenceCameraId },
    supersedes,
    createdAt: input.createdAt,
  })
}

// ---------------------------------------------------------------------------
// Range overrides
// ---------------------------------------------------------------------------

/**
 * Amend a plan with a local correction. The result is a new plan that
 * supersedes the old one; the camera transforms are copied untouched, so a
 * local change cannot leak into the global correction or into sibling
 * segments (ADR-127). The override names who asked for it and why.
 */
export function addMulticamMatchRangeOverride(
  plan: Readonly<MulticamMatchPlan>,
  input: {
    planId: string
    createdAt: string
    override: {
      overrideId: string
      cameraId: string
      segmentId?: string
      range?: Readonly<TickInterval>
      parameters: Readonly<MatchAdjustParameters>
      reason: string
      actor: Readonly<MatchActor>
    }
  },
): Readonly<MulticamMatchPlan> {
  const previous = assertMulticamMatchPlanIntegrity(plan)
  const cameraId = assertToken(input.override.cameraId, 'override.cameraId')
  const metadata = previous.measurements.find((measurement) => measurement.cameraId === previous.referenceCameraId)!.technical.metadata
  const segmentId = input.override.segmentId !== undefined ? assertToken(input.override.segmentId, 'override.segmentId') : undefined
  const override: MatchRangeOverride = {
    overrideId: input.override.overrideId,
    cameraId,
    ...(segmentId !== undefined ? { segmentId } : {}),
    ...(input.override.range !== undefined ? { range: input.override.range } : {}),
    transform: createMatchAdjustTransform({
      cameraId,
      metadata,
      parameters: input.override.parameters,
      segmentId: segmentId ?? `r${input.override.range!.start.toString()}-${input.override.range!.end.toString()}`,
    }),
    reason: input.override.reason,
    actor: input.override.actor,
  }
  const { planHash: _planHash, ...content } = previous
  return createMulticamMatchPlan({
    ...content,
    planId: input.planId,
    rangeOverrides: [...previous.rangeOverrides, override],
    supersedes: previous.planId,
    createdAt: input.createdAt,
  })
}

// ---------------------------------------------------------------------------
// Compilation to ColorPlan layers
// ---------------------------------------------------------------------------

export interface EditPlanClipRef {
  readonly clipId: string
  /** Session ticks the clip covers; needed to place range overrides. */
  readonly sessionRange?: Readonly<TickInterval>
}

export interface CompiledMatchPlanLayers {
  readonly cameras: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  readonly segments: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  /** Cameras the plan corrected but the EditPlan does not use. */
  readonly omittedCameraIds: readonly string[]
}

/**
 * The `cameras` and `segments` layers, in the exact shape `createColorPlan`
 * and `setProjectColorPlanService` accept. Only cameras the EditPlan actually
 * cuts to are emitted — the plan service refuses override keys outside the
 * EditPlan targets (`project-color-plans.ts:66-94`) — and the ones left out
 * are named so nobody has to diff to find them.
 */
export function compileMatchPlanToColorPlanLayers(
  plan: Readonly<MulticamMatchPlan>,
  input: { editPlanClipsByCameraId: Readonly<Record<string, readonly Readonly<EditPlanClipRef>[]>> },
): Readonly<CompiledMatchPlanLayers> {
  const verified = assertMulticamMatchPlanIntegrity(plan)
  const clipsByCamera = input.editPlanClipsByCameraId
  const metadata = verified.measurements.find((measurement) => measurement.cameraId === verified.referenceCameraId)!.technical.metadata
  const cameras: Record<string, readonly Readonly<ColorTransform>[]> = {}
  const omitted: string[] = []

  if (clipsByCamera[verified.referenceCameraId]) {
    cameras[verified.referenceCameraId] = Object.freeze([createMatchBypassTransform({ cameraId: verified.referenceCameraId, metadata })])
  } else {
    omitted.push(verified.referenceCameraId)
  }
  for (const entry of verified.cameraTransforms) {
    if (!clipsByCamera[entry.cameraId]) {
      omitted.push(entry.cameraId)
      continue
    }
    cameras[entry.cameraId] = Object.freeze([entry.transform])
  }

  const segments: Record<string, readonly Readonly<ColorTransform>[]> = {}
  for (const override of verified.rangeOverrides) {
    const clips = clipsByCamera[override.cameraId] ?? []
    const targets = override.segmentId !== undefined
      ? clips.filter((clip) => clip.clipId === override.segmentId).map((clip) => clip.clipId)
      : clips
          .filter((clip) => clip.sessionRange !== undefined && intervalsOverlap(clip.sessionRange, override.range!))
          .map((clip) => clip.clipId)
    assertDomain(
      targets.length > 0,
      'INVALID_ARGUMENT',
      `override ${override.overrideId} matches no clip of camera ${override.cameraId} in the EditPlan`,
      { overrideId: override.overrideId, cameraId: override.cameraId },
    )
    for (const clipId of targets) {
      const key = assertToken(clipId, 'clipId')
      assertDomain(
        segments[key] === undefined,
        'INVALID_ARGUMENT',
        `clip ${key} is targeted by more than one override`,
        { clipId: key, overrideId: override.overrideId },
      )
      segments[key] = Object.freeze([createMatchAdjustTransform({
        cameraId: override.cameraId,
        metadata,
        parameters: {
          brightness: Number(override.transform.implementation.parameters.brightness ?? 0),
          contrast: Number(override.transform.implementation.parameters.contrast ?? 1),
          saturation: Number(override.transform.implementation.parameters.saturation ?? 1),
          ...(override.transform.implementation.version === MATCH_PROVIDER_VERSIONS.v2.version
            ? {
                gains: {
                  redGain: Number(override.transform.implementation.parameters.redGain),
                  greenGain: Number(override.transform.implementation.parameters.greenGain),
                  blueGain: Number(override.transform.implementation.parameters.blueGain),
                },
              }
            : {}),
        },
        segmentId: key,
      })])
    }
  }

  for (const layer of [...Object.values(cameras), ...Object.values(segments)]) assertMatchStagePosition(layer)
  return Object.freeze({
    cameras: Object.freeze(cameras),
    segments: Object.freeze(segments),
    omittedCameraIds: Object.freeze(omitted.sort()),
  })
}
