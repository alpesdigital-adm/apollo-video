import { calculateCanonicalHash } from './canonical-hash.ts'
import type { ColorMetadata } from './color-and-export.ts'
import { assertDomain } from './errors.ts'
import {
  createTickInterval,
  serializeTickInterval,
  type TickInterval,
} from './session-time.ts'

/**
 * Pixel-level colour evidence for one camera over one range (F4.013/F4.014).
 *
 * `media-color-probe/v1` reads container tags and decodes nothing; this
 * aggregate is the thing it is not — statistics read from decoded frames. It
 * is deliberately a new schema rather than a mutation of the probe, because a
 * probe that sometimes carries pixels and sometimes does not would make every
 * reader guess which one it holds.
 *
 * Three rules, all from ADR-147, are enforced at construction:
 *
 * - **Every dimension answers.** `measured`, `not-applicable` or `unavailable`;
 *   silence is refused. A measured dimension names its evaluator, its unit and
 *   its evidence. An unmeasured one carries no value at all — a zero would
 *   assert "measured and useless", which is a different claim.
 * - **The evaluator's kind travels with the number.** `measured` means an
 *   instrument read it from the bytes; `controlled` means a deterministic
 *   stand-in for a perceptual model that is not deployed. The skin band mask
 *   is the second kind and is never described as verified skin.
 * - **Ticks are `bigint`.** The session range is a Wave 18 `TickInterval` and
 *   is serialized to decimal text before it reaches the canonical hash, the
 *   same way every other tick-bearing aggregate does it.
 */

export const CAMERA_COLOR_MEASUREMENT_SCHEMA_VERSION = 'camera-color-measurement/v1' as const

export const COLOR_MEASUREMENT_DIMENSIONS = Object.freeze([
  'whiteBalance',
  'exposure',
  'contrast',
  'blacks',
  'highlights',
  'saturation',
  'tonalResponse',
  'skin',
] as const)
export type ColorMeasurementDimension = (typeof COLOR_MEASUREMENT_DIMENSIONS)[number]

export const COLOR_MEASUREMENT_STATUSES = Object.freeze([
  'measured',
  'not-applicable',
  'unavailable',
] as const)
export type ColorMeasurementStatus = (typeof COLOR_MEASUREMENT_STATUSES)[number]

export const COLOR_EVALUATOR_KINDS = Object.freeze(['measured', 'controlled'] as const)
export type ColorEvaluatorKind = (typeof COLOR_EVALUATOR_KINDS)[number]

/**
 * The unit each dimension is reported in. Fixed per dimension so two
 * measurements of the same dimension are always in the same quantity; a
 * reader comparing "exposure 0.42" to "exposure 0.55" must not have to check
 * whether one of them is in stops.
 */
export const COLOR_MEASUREMENT_UNITS = Object.freeze({
  /** Blue-over-red channel mean ratio; > 1 leans blue, < 1 leans red. */
  whiteBalance: 'ratio',
  /** Mean BT.709 luma over decoded RGB, 0–1. */
  exposure: 'normalized-luma',
  /** Standard deviation of luma, 0–1. */
  contrast: 'normalized-luma',
  /** Share of sampled pixels at or below the crush threshold. */
  blacks: 'ratio',
  /** Share of sampled pixels at or above the clip threshold. */
  highlights: 'ratio',
  /** Mean chroma magnitude in BT.709 Cb/Cr, 0–~0.7. */
  saturation: 'normalized-chroma',
  /** Median luma; percentiles P1…P99 ride along as components. */
  tonalResponse: 'normalized-luma',
  /** Hue angle of the mean chroma of skin-band pixels, degrees. */
  skin: 'degrees',
} as const satisfies Readonly<Record<ColorMeasurementDimension, string>>)

export const HDR_MODES = Object.freeze(['sdr', 'hlg', 'pq'] as const)
export type HdrMode = (typeof HDR_MODES)[number]

export interface ColorEvaluatorRef {
  readonly id: string
  readonly kind: ColorEvaluatorKind
  readonly version: string
}

export interface ColorMeasurementDimensionResult {
  readonly status: ColorMeasurementStatus
  readonly value?: number
  readonly unit?: string
  readonly evaluator?: Readonly<ColorEvaluatorRef>
  readonly evidenceRef?: string
  /** Named finite sub-values (percentiles, channel ratios, mask area). */
  readonly components?: Readonly<Record<string, number>>
  /** Why the dimension is not measured. Required exactly when it is not. */
  readonly reason?: string
}

/** What ffprobe said about the bytes that were measured. */
export interface ColorMeasurementTechnical {
  readonly metadata: Readonly<ColorMetadata>
  readonly pixelFormat: string
  readonly hdrMode: HdrMode
}

/** Frame indices of the measured source, half-open `[startFrame, endFrame)`. */
export interface SourceFrameRange {
  readonly startFrame: number
  readonly endFrame: number
}

export interface ColorMeasurementComparability {
  readonly comparable: boolean
  readonly reasons: readonly string[]
}

export interface ColorMeasurementIssue {
  readonly code: string
  readonly message: string
}

export interface CameraColorMeasurement {
  readonly schemaVersion: typeof CAMERA_COLOR_MEASUREMENT_SCHEMA_VERSION
  readonly measurementId: string
  readonly sessionId: string | null
  readonly sourceAssetId: string
  readonly sourceSha256: string
  readonly cameraId: string
  /** Session ticks this measurement describes. */
  readonly range: Readonly<TickInterval>
  /** The frames of the source that were decoded for it. */
  readonly sourceRange: Readonly<SourceFrameRange>
  readonly sampledFrames: number
  readonly technical: Readonly<ColorMeasurementTechnical>
  readonly dimensions: Readonly<Record<ColorMeasurementDimension, Readonly<ColorMeasurementDimensionResult>>>
  readonly comparability: Readonly<ColorMeasurementComparability>
  /** How much the measurement itself is worth: sample density, in [0, 1]. */
  readonly confidence: number
  readonly issues: readonly Readonly<ColorMeasurementIssue>[]
  readonly measurementHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
/** The ColorPlan camera key grammar (`color-and-export.ts:80`), lowercase only. */
const CAMERA_TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
/**
 * Component names are read by people and by the match derivation, which asks
 * for `rOverG` and `bOverG` by name. They are not ColorPlan keys, so they use
 * the identifier grammar rather than the lowercase token one; the token
 * grammar would have rejected every white-balance measurement this module can
 * produce.
 */
const COMPONENT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Below this many decoded frames a range has not been measured, whatever the
 * numbers say: one frame is a still, not a statistic. Shared with the match
 * derivation so the two never disagree about what "measured" means.
 */
export const COLOR_MEASUREMENT_MINIMUM_FRAMES = 3

/**
 * Dimensions a measurement must carry as `measured` to be comparable to
 * another camera. Skin and tonal response are informative; these four are the
 * quantities a match is built from.
 */
export const COLOR_MEASUREMENT_COMPARABILITY_DIMENSIONS = Object.freeze([
  'whiteBalance',
  'exposure',
  'contrast',
  'saturation',
] as const satisfies readonly ColorMeasurementDimension[])

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

function assertComponentKey(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && COMPONENT_KEY.test(value), 'INVALID_ARGUMENT', `${field} is not a component name`)
  return value
}

function assertFinite(value: unknown, field: string): number {
  assertDomain(typeof value === 'number' && Number.isFinite(value), 'INVALID_ARGUMENT', `${field} must be a finite number`)
  return value
}

function assertUnitInterval(value: unknown, field: string): number {
  const finite = assertFinite(value, field)
  assertDomain(finite >= 0 && finite <= 1, 'INVALID_ARGUMENT', `${field} must be within [0, 1]`)
  return finite
}

function normalizedMetadata(value: Readonly<ColorMetadata>, field: string): Readonly<ColorMetadata> {
  assertDomain(value && typeof value === 'object', 'INVALID_ARGUMENT', `${field} is invalid`)
  assertDomain(value.range === 'full' || value.range === 'limited', 'INVALID_ARGUMENT', `${field}.range is invalid`)
  assertDomain(
    Number.isSafeInteger(value.bitDepth) && value.bitDepth >= 8 && value.bitDepth <= 32,
    'INVALID_ARGUMENT',
    `${field}.bitDepth is invalid`,
  )
  return Object.freeze({
    colorSpace: assertToken(value.colorSpace, `${field}.colorSpace`),
    transfer: assertToken(value.transfer, `${field}.transfer`),
    primaries: assertToken(value.primaries, `${field}.primaries`),
    matrix: assertToken(value.matrix, `${field}.matrix`),
    range: value.range,
    bitDepth: value.bitDepth,
  })
}

function normalizedEvaluator(value: Readonly<ColorEvaluatorRef> | undefined, field: string): Readonly<ColorEvaluatorRef> {
  assertDomain(value && typeof value === 'object', 'INVALID_ARGUMENT', `${field} must name its evaluator`)
  assertDomain(COLOR_EVALUATOR_KINDS.includes(value.kind), 'INVALID_ARGUMENT', `${field}.kind must say whether it measured or stood in`)
  return Object.freeze({
    id: assertId(value.id, `${field}.id`),
    kind: value.kind,
    version: assertToken(value.version, `${field}.version`),
  })
}

function normalizedDimension(
  dimension: ColorMeasurementDimension,
  value: Readonly<ColorMeasurementDimensionResult> | undefined,
): Readonly<ColorMeasurementDimensionResult> {
  const field = `dimensions.${dimension}`
  assertDomain(
    value && typeof value === 'object' && COLOR_MEASUREMENT_STATUSES.includes(value.status),
    'INVALID_ARGUMENT',
    `${field} must state measured, not-applicable or unavailable`,
  )
  if (value.status === 'measured') {
    const numeric = assertFinite(value.value, `${field}.value`)
    assertDomain(
      value.unit === COLOR_MEASUREMENT_UNITS[dimension],
      'INVALID_ARGUMENT',
      `${field}.unit must be ${COLOR_MEASUREMENT_UNITS[dimension]}`,
    )
    assertDomain(
      typeof value.evidenceRef === 'string' && value.evidenceRef.trim().length > 0,
      'INVALID_ARGUMENT',
      `${field} must reference its evidence`,
    )
    assertDomain(value.reason === undefined, 'INVALID_ARGUMENT', `${field} is measured and must not carry a reason`)
    const components = value.components === undefined
      ? undefined
      : Object.freeze(Object.fromEntries(
          Object.entries(value.components)
            .map(([key, nested]) => [assertComponentKey(key, `${field}.components key`), assertFinite(nested, `${field}.components.${key}`)] as const)
            .sort(([left], [right]) => left.localeCompare(right)),
        ))
    return Object.freeze({
      status: 'measured' as const,
      value: numeric,
      unit: value.unit,
      evaluator: normalizedEvaluator(value.evaluator, `${field}.evaluator`),
      evidenceRef: value.evidenceRef,
      ...(components ? { components } : {}),
    })
  }
  // Nothing was measured, so nothing may look like a measurement.
  assertDomain(
    value.value === undefined && value.unit === undefined && value.evaluator === undefined &&
      value.evidenceRef === undefined && value.components === undefined,
    'INVALID_ARGUMENT',
    `${field} is ${value.status} and must not carry a value`,
  )
  assertDomain(
    typeof value.reason === 'string' && value.reason.trim().length >= 10,
    'INVALID_ARGUMENT',
    `${field} is ${value.status} and must say why`,
  )
  return Object.freeze({ status: value.status, reason: value.reason })
}

function deriveComparability(input: {
  sampledFrames: number
  technical: Readonly<ColorMeasurementTechnical>
  dimensions: Readonly<Record<ColorMeasurementDimension, Readonly<ColorMeasurementDimensionResult>>>
}): Readonly<ColorMeasurementComparability> {
  const reasons: string[] = []
  if (input.technical.hdrMode !== 'sdr') reasons.push('hdr-transfer-without-tone-map')
  if (input.sampledFrames < COLOR_MEASUREMENT_MINIMUM_FRAMES) reasons.push('insufficient-sampled-frames')
  for (const dimension of COLOR_MEASUREMENT_COMPARABILITY_DIMENSIONS) {
    if (input.dimensions[dimension].status !== 'measured') reasons.push(`${dimension}-not-measured`)
  }
  return Object.freeze({ comparable: reasons.length === 0, reasons: Object.freeze(reasons) })
}

export type CameraColorMeasurementContent = Omit<CameraColorMeasurement, 'measurementHash'>

/**
 * Every `bigint` leaf as decimal text, structure otherwise untouched.
 *
 * The canonical hasher throws on a `bigint` rather than guessing a
 * representation (`canonical-hash.ts:27`), so a tick-bearing aggregate has to
 * be flattened before it is hashed. `serializeTickInterval` does it for one
 * interval; this does it for an aggregate that carries intervals several
 * levels down, and produces the identical `{ start, end }` text pair for each
 * of them, so the two ways of hashing never disagree.
 */
export function serializeTicksDeep(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(serializeTicksDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, serializeTicksDeep(nested)]),
    )
  }
  return value
}

/** The bytes that are hashed: ticks as decimal text, keys sorted by the hasher. */
export function calculateCameraColorMeasurementHash(content: Readonly<CameraColorMeasurementContent>): string {
  return calculateCanonicalHash({ ...content, range: serializeTickInterval(content.range) })
}

export function createCameraColorMeasurement(input: {
  measurementId: string
  sessionId?: string | null
  sourceAssetId: string
  sourceSha256: string
  cameraId: string
  range: Readonly<TickInterval>
  sourceRange: Readonly<SourceFrameRange>
  sampledFrames: number
  technical: Readonly<ColorMeasurementTechnical>
  dimensions: Readonly<Partial<Record<ColorMeasurementDimension, Readonly<ColorMeasurementDimensionResult>>>>
  confidence: number
  issues?: readonly Readonly<ColorMeasurementIssue>[]
}): Readonly<CameraColorMeasurement> {
  assertDomain(
    typeof input.cameraId === 'string' && CAMERA_TOKEN.test(input.cameraId),
    'INVALID_ARGUMENT',
    'cameraId must satisfy the ColorPlan camera key grammar (lowercase token)',
  )
  assertDomain(
    Number.isSafeInteger(input.sourceRange?.startFrame) && input.sourceRange.startFrame >= 0 &&
      Number.isSafeInteger(input.sourceRange?.endFrame) && input.sourceRange.endFrame > input.sourceRange.startFrame,
    'INVALID_ARGUMENT',
    'sourceRange must be a non-empty forward frame range [startFrame, endFrame)',
  )
  assertDomain(
    Number.isSafeInteger(input.sampledFrames) && input.sampledFrames >= 0,
    'INVALID_ARGUMENT',
    'sampledFrames must be a non-negative integer',
  )
  assertDomain(HDR_MODES.includes(input.technical?.hdrMode), 'INVALID_ARGUMENT', 'technical.hdrMode is invalid')
  const technical = Object.freeze({
    metadata: normalizedMetadata(input.technical.metadata, 'technical.metadata'),
    pixelFormat: assertToken(input.technical.pixelFormat, 'technical.pixelFormat'),
    hdrMode: input.technical.hdrMode,
  })
  const dimensions = Object.freeze(Object.fromEntries(
    COLOR_MEASUREMENT_DIMENSIONS.map((dimension) => [dimension, normalizedDimension(dimension, input.dimensions?.[dimension])] as const),
  )) as Readonly<Record<ColorMeasurementDimension, Readonly<ColorMeasurementDimensionResult>>>
  if (input.sampledFrames === 0) {
    assertDomain(
      COLOR_MEASUREMENT_DIMENSIONS.every((dimension) => dimensions[dimension].status !== 'measured'),
      'INVALID_ARGUMENT',
      'a measurement with no sampled frames cannot carry a measured dimension',
    )
  }
  const issues = Object.freeze((input.issues ?? []).map((issue, index) => {
    assertDomain(
      typeof issue?.code === 'string' && TOKEN.test(issue.code) && typeof issue.message === 'string' && issue.message.trim().length > 0,
      'INVALID_ARGUMENT',
      `issues[${index}] must carry a token code and a message`,
    )
    return Object.freeze({ code: issue.code, message: issue.message })
  }))
  const content: CameraColorMeasurementContent = Object.freeze({
    schemaVersion: CAMERA_COLOR_MEASUREMENT_SCHEMA_VERSION,
    measurementId: assertId(input.measurementId, 'measurementId'),
    sessionId: input.sessionId === undefined || input.sessionId === null ? null : assertId(input.sessionId, 'sessionId'),
    sourceAssetId: assertId(input.sourceAssetId, 'sourceAssetId'),
    sourceSha256: assertHash(input.sourceSha256, 'sourceSha256'),
    cameraId: input.cameraId,
    range: createTickInterval(input.range.start, input.range.end),
    sourceRange: Object.freeze({ startFrame: input.sourceRange.startFrame, endFrame: input.sourceRange.endFrame }),
    sampledFrames: input.sampledFrames,
    technical,
    dimensions,
    comparability: deriveComparability({ sampledFrames: input.sampledFrames, technical, dimensions }),
    confidence: assertUnitInterval(input.confidence, 'confidence'),
    issues,
  })
  return Object.freeze({ ...content, measurementHash: calculateCameraColorMeasurementHash(content) })
}

/**
 * Re-verify a measurement that came back from storage. The hash is recomputed
 * from the content, so a value edited underneath the row is refused rather
 * than believed.
 */
export function assertCameraColorMeasurementIntegrity(
  measurement: Readonly<CameraColorMeasurement>,
): Readonly<CameraColorMeasurement> {
  assertDomain(
    measurement.schemaVersion === CAMERA_COLOR_MEASUREMENT_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored camera colour measurement schema is unknown',
  )
  const { measurementHash, ...content } = measurement
  assertDomain(
    calculateCameraColorMeasurementHash(content) === measurementHash,
    'PERSISTENCE_CONFLICT',
    'camera colour measurement hash does not match its stored content',
  )
  return measurement
}

/** The measured number of a dimension, or null when it was not measured. */
export function measuredValue(
  measurement: Readonly<CameraColorMeasurement>,
  dimension: ColorMeasurementDimension,
): number | null {
  const result = measurement.dimensions[dimension]
  return result.status === 'measured' ? result.value! : null
}

/** A named component of a measured dimension, or null. */
export function measuredComponent(
  measurement: Readonly<CameraColorMeasurement>,
  dimension: ColorMeasurementDimension,
  component: string,
): number | null {
  const result = measurement.dimensions[dimension]
  if (result.status !== 'measured') return null
  const value = result.components?.[component]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
