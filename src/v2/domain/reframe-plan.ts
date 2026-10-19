import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { OUTPUT_FORMAT_REGISTRY, readOutputFormatPreset } from './output-format-registry.ts'
import type { NormalizedBounds, NormalizedInsets, OutputAspectRatio } from './output-spec.ts'
import { isPinnedReframePolicy, REFRAME_POLICY, REFRAME_POLICY_SHA256, type ReframePolicyV1 } from './reframe-policy.ts'

export const REFRAME_ROI_KINDS = ['face', 'object', 'screen', 'region-of-interest'] as const
export type ReframeRoiKind = (typeof REFRAME_ROI_KINDS)[number]

export interface ReframeObservationV1 {
  id: string
  subjectId: string
  kind: ReframeRoiKind
  startFrame: number
  endFrame: number
  bounds: Readonly<NormalizedBounds>
  confidence: number
  priority: number
  critical: boolean
}

export interface ReframeObservationSetV1 {
  schemaVersion: 'reframe-observations/v1'
  id: string
  sourceArtifactId: string
  sourceManifestId: string
  sourceSha256: string
  sourceWidth: number
  sourceHeight: number
  fps: number
  durationFrames: number
  observations: readonly Readonly<ReframeObservationV1>[]
  contentHash: string
}

/** Why a range of the timeline has no usable evidence. Never silently replaced by "no subject". */
export const REFRAME_UNKNOWN_REASONS = ['UNKNOWN_SAMPLE', 'WINDOW_GAP', 'UNTRUSTED_EVIDENCE', 'UNSUPPORTED_CLIP'] as const
export type ReframeUnknownReason = (typeof REFRAME_UNKNOWN_REASONS)[number]

export interface ReframeObservationV2 extends ReframeObservationV1 {
  /** The sealed evidence this observation was projected from (envelope content addresses). */
  evidenceIds: readonly string[]
}
export interface ReframeUnknownRangeV1 {
  id: string
  startFrame: number
  endFrame: number
  reasonCode: ReframeUnknownReason
  evidenceIds: readonly string[]
}
export interface ReframeEvidenceStreamRefV1 {
  id: string
  kind: 'face-source-evidence-stream'
  sourceArtifactId: string
  streamHash: string
  policySha256: string
  trustedEnvelopeHashes: readonly string[]
  untrusted: readonly Readonly<{ envelopeHash: string; reasons: readonly string[] }>[]
}
export interface ReframeRoiAvailabilityV1 {
  face: Readonly<{ status: 'present' | 'partial' | 'absent'; reasonCode: string | null }>
  object: Readonly<{ status: 'absent'; reasonCode: 'NO_VERIFIED_DETECTOR' }>
  screen: Readonly<{ status: 'absent'; reasonCode: 'NO_VERIFIED_PRODUCER' }>
}

/**
 * Observations the SERVER derived from sealed, authenticated evidence (W66r). Nothing a caller sends is ever this: the schema
 * carries the evidence it was projected from, the ranges where evidence is absent, and the timeline frames where tracking must
 * restart (clip boundaries). `createReframePlan` refuses it unless `authority` is `server-owned`.
 */
export interface ReframeObservationSetV2 {
  schemaVersion: 'reframe-observations/v2'
  authority: 'server-owned'
  id: string
  sourceArtifactId: string
  sourceManifestId: string
  sourceSha256: string
  sourceWidth: number
  sourceHeight: number
  fps: number
  durationFrames: number
  evidence: readonly Readonly<ReframeEvidenceStreamRefV1>[]
  roi: Readonly<ReframeRoiAvailabilityV1>
  observations: readonly Readonly<ReframeObservationV2>[]
  unknownRanges: readonly Readonly<ReframeUnknownRangeV1>[]
  /** Timeline frames (clip starts) where the tracking state restarts: a cut is never interpolated across. */
  trackingBreaks: readonly number[]
  contentHash: string
}
export type ReframeObservationSet = ReframeObservationSetV1 | ReframeObservationSetV2

export interface ReframeManualOverrideV1 {
  id: string
  format: OutputAspectRatio
  startFrame: number
  endFrame: number
  crop: Readonly<NormalizedBounds>
}

export interface ReframePlanIssueV1 {
  code: 'PERCEPTION_UNCERTAIN' | 'SUBJECTS_DO_NOT_FIT' | 'NO_SUBJECT_OBSERVATION' | 'TRACKING_LIMIT_EXCEEDED'
  format: OutputAspectRatio
  startFrame: number
  endFrame: number
  observationIds: readonly string[]
}
export interface ReframePlanIssueV2 extends ReframePlanIssueV1 {
  /** Why the range is uncertain, when it is because evidence is absent. */
  reasonCode: ReframeUnknownReason | 'LOW_CONFIDENCE' | null
  evidenceIds: readonly string[]
}

export interface ReframePlanSegmentV1 {
  startFrame: number
  endFrame: number
  mode: 'crop' | 'contain'
  crop: Readonly<NormalizedBounds> | null
  source: ReframeRoiKind | 'multiple-subjects' | 'manual' | 'fallback'
  observationIds: readonly string[]
  subjectIds: readonly string[]
  velocity: Readonly<{ x: number; y: number }>
}

export interface ReframePlanV1 {
  schemaVersion: 'reframe-plan/v1'
  format: OutputAspectRatio
  observationSetId: string
  observationSetHash: string
  outputFormatRegistryHash: string
  outputPresetHash: string
  maxVelocityPerSecond: number
  maxAccelerationPerSecondSquared: number
  safetyMargin: number
  segments: readonly Readonly<ReframePlanSegmentV1>[]
  issues: readonly Readonly<ReframePlanIssueV1>[]
  planHash: string
}

/** The sealed facts of the variant the plan is decided for. The canvas is the variant's own, never a registry preset by aspect ratio. */
export interface ReframeVariantCanvasV1 {
  variantId: string
  outputSpecRevisionId: string
  specHash: string
  aspectRatio: OutputAspectRatio
  safeArea: Readonly<NormalizedInsets>
}

/** `reframe-plan/v2` (W66r): sealed to the policy that produced it and to the variant's own sealed spec, not to a registry preset. */
export interface ReframePlanV2 {
  schemaVersion: 'reframe-plan/v2'
  format: OutputAspectRatio
  variant: Readonly<ReframeVariantCanvasV1>
  observationSetId: string
  observationSetHash: string
  policyId: string
  policyHash: string
  maxVelocityPerSecond: number
  maxAccelerationPerSecondSquared: number
  safetyMargin: number
  /** Timeline frames where the tracking state restarted (cuts and the end of a manual range). */
  trackingBreaks: readonly number[]
  segments: readonly Readonly<ReframePlanSegmentV1>[]
  issues: readonly Readonly<ReframePlanIssueV2>[]
  planHash: string
}
export type ReframePlan = ReframePlanV1 | ReframePlanV2

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/
export const REFRAME_EPSILON = 1e-7
const EPSILON = REFRAME_EPSILON
const MAX_OBSERVATIONS_V1 = 10_000
const MAX_OBSERVATIONS_V2 = 40_000
const MAX_SEGMENTS = 20_000

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  assertDomain(unknown.length === 0, 'INVALID_RENDER_INPUT', `${field} contains unsupported fields`, { fields: unknown })
}

function exactAll(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  exact(value, keys, field)
  const missing = keys.filter((key) => !Object.hasOwn(value, key))
  assertDomain(missing.length === 0, 'INVALID_RENDER_INPUT', `${field} is missing fields`, { fields: missing })
}

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(Boolean(value) && typeof value === 'object' && !Array.isArray(value), 'INVALID_RENDER_INPUT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_RENDER_INPUT', `${field} is invalid`)
  return value
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  assertDomain(Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum, 'INVALID_RENDER_INPUT', `${field} is invalid`)
  return Number(value)
}

function finite(value: unknown, field: string, minimum: number, maximum: number): number {
  assertDomain(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum, 'INVALID_RENDER_INPUT', `${field} is invalid`)
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && SHA256.test(value), 'INVALID_RENDER_INPUT', `${field} is invalid`)
  return value
}

function bounds(value: unknown, field: string): Readonly<NormalizedBounds> {
  const item = record(value, field)
  exact(item, ['x', 'y', 'width', 'height'], field)
  const parsed = {
    x: finite(item.x, `${field}.x`, 0, 1), y: finite(item.y, `${field}.y`, 0, 1),
    width: finite(item.width, `${field}.width`, EPSILON, 1), height: finite(item.height, `${field}.height`, EPSILON, 1),
  }
  assertDomain(parsed.x + parsed.width <= 1 + EPSILON && parsed.y + parsed.height <= 1 + EPSILON, 'INVALID_RENDER_INPUT', `${field} exceeds source bounds`)
  return Object.freeze(parsed)
}

function parseObservation(value: unknown, index: number, durationFrames: number, v2: boolean): Readonly<ReframeObservationV1 | ReframeObservationV2> {
  const field = `observations[${index}]`
  const item = record(value, field)
  exact(item, ['id', 'subjectId', 'kind', 'startFrame', 'endFrame', 'bounds', 'confidence', 'priority', 'critical', ...(v2 ? ['evidenceIds'] : [])], field)
  const startFrame = integer(item.startFrame, `${field}.startFrame`, 0, durationFrames - 1)
  const endFrame = integer(item.endFrame, `${field}.endFrame`, startFrame + 1, durationFrames)
  assertDomain(typeof item.kind === 'string' && REFRAME_ROI_KINDS.includes(item.kind as ReframeRoiKind), 'INVALID_RENDER_INPUT', `${field}.kind is invalid`)
  assertDomain(typeof item.critical === 'boolean', 'INVALID_RENDER_INPUT', `${field}.critical is invalid`)
  const base = {
    id: identifier(item.id, `${field}.id`), subjectId: identifier(item.subjectId, `${field}.subjectId`),
    kind: item.kind as ReframeRoiKind, startFrame, endFrame, bounds: bounds(item.bounds, `${field}.bounds`),
    confidence: finite(item.confidence, `${field}.confidence`, 0, 1),
    priority: integer(item.priority, `${field}.priority`, 0, 100), critical: item.critical,
  }
  if (!v2) return Object.freeze(base)
  assertDomain(Array.isArray(item.evidenceIds) && item.evidenceIds.length >= 1 && item.evidenceIds.length <= 8, 'INVALID_RENDER_INPUT', `${field}.evidenceIds is invalid`)
  return Object.freeze({ ...base, evidenceIds: Object.freeze(item.evidenceIds.map((entry, position) => identifier(entry, `${field}.evidenceIds[${position}]`))) })
}

export function createReframeObservationSet(input: Omit<ReframeObservationSetV1, 'schemaVersion' | 'contentHash'>): Readonly<ReframeObservationSetV1> {
  const body = parseReframeObservationSetV1({ ...input, schemaVersion: 'reframe-observations/v1', contentHash: '0'.repeat(64) }, false)
  const { contentHash: _contentHash, ...content } = body
  return Object.freeze({ ...content, contentHash: calculateCanonicalHash(content) })
}

export function createReframeObservationSetV2(input: Omit<ReframeObservationSetV2, 'schemaVersion' | 'authority' | 'contentHash'>): Readonly<ReframeObservationSetV2> {
  const body = parseReframeObservationSetV2({ ...input, schemaVersion: 'reframe-observations/v2', authority: 'server-owned', contentHash: '0'.repeat(64) }, false)
  const { contentHash: _contentHash, ...content } = body
  return Object.freeze({ ...content, contentHash: calculateCanonicalHash(content) })
}

function parseReframeObservationSetV1(value: unknown, verifyHash: boolean): Readonly<ReframeObservationSetV1> {
  const item = record(value, 'observationSet')
  exact(item, ['schemaVersion', 'id', 'sourceArtifactId', 'sourceManifestId', 'sourceSha256', 'sourceWidth', 'sourceHeight', 'fps', 'durationFrames', 'observations', 'contentHash'], 'observationSet')
  assertDomain(item.schemaVersion === 'reframe-observations/v1', 'INVALID_RENDER_INPUT', 'Observation set schema version is unsupported')
  const durationFrames = integer(item.durationFrames, 'observationSet.durationFrames', 1, 2_592_000)
  assertDomain(Array.isArray(item.observations) && item.observations.length > 0 && item.observations.length <= MAX_OBSERVATIONS_V1, 'INVALID_RENDER_INPUT', 'Observation set observations are invalid')
  const observations = item.observations.map((entry, index) => parseObservation(entry, index, durationFrames, false) as Readonly<ReframeObservationV1>)
    .toSorted((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame || left.id.localeCompare(right.id))
  assertDomain(new Set(observations.map((entry) => entry.id)).size === observations.length, 'INVALID_RENDER_INPUT', 'Observation IDs must be unique')
  const parsed = Object.freeze({
    schemaVersion: 'reframe-observations/v1' as const,
    id: identifier(item.id, 'observationSet.id'), sourceArtifactId: identifier(item.sourceArtifactId, 'observationSet.sourceArtifactId'),
    sourceManifestId: identifier(item.sourceManifestId, 'observationSet.sourceManifestId'),
    sourceSha256: typeof item.sourceSha256 === 'string' && SHA256.test(item.sourceSha256) ? item.sourceSha256 : '',
    sourceWidth: integer(item.sourceWidth, 'observationSet.sourceWidth', 2, 16_384),
    sourceHeight: integer(item.sourceHeight, 'observationSet.sourceHeight', 2, 16_384),
    fps: integer(item.fps, 'observationSet.fps', 1, 120), durationFrames,
    observations: Object.freeze(observations),
    contentHash: typeof item.contentHash === 'string' ? item.contentHash : '',
  })
  assertDomain(SHA256.test(parsed.sourceSha256), 'INVALID_RENDER_INPUT', 'Observation source SHA-256 is invalid')
  const { contentHash, ...content } = parsed
  if (verifyHash) assertDomain(SHA256.test(contentHash) && contentHash === calculateCanonicalHash(content), 'INVALID_RENDER_INPUT', 'Observation set content hash is inconsistent')
  return parsed
}

function parseEvidenceRef(value: unknown, index: number): Readonly<ReframeEvidenceStreamRefV1> {
  const field = `evidence[${index}]`
  const item = record(value, field)
  exactAll(item, ['id', 'kind', 'sourceArtifactId', 'streamHash', 'policySha256', 'trustedEnvelopeHashes', 'untrusted'], field)
  assertDomain(item.kind === 'face-source-evidence-stream', 'INVALID_RENDER_INPUT', `${field}.kind is invalid`)
  assertDomain(Array.isArray(item.trustedEnvelopeHashes) && item.trustedEnvelopeHashes.length <= 4_000 &&
    Array.isArray(item.untrusted) && item.untrusted.length <= 4_000, 'INVALID_RENDER_INPUT', `${field} windows are invalid`)
  return Object.freeze({
    id: identifier(item.id, `${field}.id`), kind: 'face-source-evidence-stream' as const,
    sourceArtifactId: identifier(item.sourceArtifactId, `${field}.sourceArtifactId`),
    streamHash: sha256(item.streamHash, `${field}.streamHash`), policySha256: sha256(item.policySha256, `${field}.policySha256`),
    trustedEnvelopeHashes: Object.freeze(item.trustedEnvelopeHashes.map((hash, position) => sha256(hash, `${field}.trustedEnvelopeHashes[${position}]`))),
    untrusted: Object.freeze(item.untrusted.map((entry, position) => {
      const untrusted = record(entry, `${field}.untrusted[${position}]`)
      exactAll(untrusted, ['envelopeHash', 'reasons'], `${field}.untrusted[${position}]`)
      assertDomain(Array.isArray(untrusted.reasons) && untrusted.reasons.length <= 16 &&
        untrusted.reasons.every((reason) => typeof reason === 'string' && REASON.test(reason)), 'INVALID_RENDER_INPUT', `${field}.untrusted reasons are invalid`)
      return Object.freeze({ envelopeHash: sha256(untrusted.envelopeHash, `${field}.untrusted[${position}].envelopeHash`), reasons: Object.freeze([...untrusted.reasons as string[]]) })
    })),
  })
}

function parseRoiAvailability(value: unknown): Readonly<ReframeRoiAvailabilityV1> {
  const roi = record(value, 'roi')
  exactAll(roi, ['face', 'object', 'screen'], 'roi')
  const face = record(roi.face, 'roi.face'), object = record(roi.object, 'roi.object'), screen = record(roi.screen, 'roi.screen')
  exactAll(face, ['status', 'reasonCode'], 'roi.face'); exactAll(object, ['status', 'reasonCode'], 'roi.object'); exactAll(screen, ['status', 'reasonCode'], 'roi.screen')
  assertDomain(['present', 'partial', 'absent'].includes(face.status as string) &&
    (face.reasonCode === null || (typeof face.reasonCode === 'string' && REASON.test(face.reasonCode))), 'INVALID_RENDER_INPUT', 'roi.face is invalid')
  // Object and screen ROI exist only when a verified producer does; none does, so the set can only say so.
  assertDomain(object.status === REFRAME_POLICY.roi.object.status && object.reasonCode === REFRAME_POLICY.roi.object.reasonCode &&
    screen.status === REFRAME_POLICY.roi.screen.status && screen.reasonCode === REFRAME_POLICY.roi.screen.reasonCode,
  'INVALID_RENDER_INPUT', 'Object and screen ROI are absent: no verified producer exists')
  return Object.freeze({
    face: Object.freeze({ status: face.status as 'present' | 'partial' | 'absent', reasonCode: face.reasonCode as string | null }),
    object: Object.freeze({ status: 'absent' as const, reasonCode: 'NO_VERIFIED_DETECTOR' as const }),
    screen: Object.freeze({ status: 'absent' as const, reasonCode: 'NO_VERIFIED_PRODUCER' as const }),
  })
}

function parseReframeObservationSetV2(value: unknown, verifyHash: boolean): Readonly<ReframeObservationSetV2> {
  const item = record(value, 'observationSet')
  exactAll(item, ['schemaVersion', 'authority', 'id', 'sourceArtifactId', 'sourceManifestId', 'sourceSha256', 'sourceWidth', 'sourceHeight', 'fps', 'durationFrames',
    'evidence', 'roi', 'observations', 'unknownRanges', 'trackingBreaks', 'contentHash'], 'observationSet')
  assertDomain(item.schemaVersion === 'reframe-observations/v2', 'INVALID_RENDER_INPUT', 'Observation set schema version is unsupported')
  assertDomain(item.authority === 'server-owned', 'INVALID_RENDER_INPUT', 'Only server-owned observations can be planned')
  const durationFrames = integer(item.durationFrames, 'observationSet.durationFrames', 1, 2_592_000)
  assertDomain(Array.isArray(item.observations) && item.observations.length <= MAX_OBSERVATIONS_V2, 'INVALID_RENDER_INPUT', 'Observation set observations are invalid')
  assertDomain(Array.isArray(item.evidence) && item.evidence.length >= 1 && item.evidence.length <= 16, 'INVALID_RENDER_INPUT', 'Observation set evidence is invalid')
  assertDomain(Array.isArray(item.unknownRanges) && item.unknownRanges.length <= MAX_OBSERVATIONS_V2, 'INVALID_RENDER_INPUT', 'Observation set unknown ranges are invalid')
  assertDomain(Array.isArray(item.trackingBreaks) && item.trackingBreaks.length <= 20_000, 'INVALID_RENDER_INPUT', 'Observation set tracking breaks are invalid')
  const observations = item.observations.map((entry, index) => parseObservation(entry, index, durationFrames, true) as Readonly<ReframeObservationV2>)
    .toSorted((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame || left.id.localeCompare(right.id))
  assertDomain(new Set(observations.map((entry) => entry.id)).size === observations.length, 'INVALID_RENDER_INPUT', 'Observation IDs must be unique')
  const evidence = item.evidence.map(parseEvidenceRef)
  assertDomain(new Set(evidence.map((entry) => entry.id)).size === evidence.length, 'INVALID_RENDER_INPUT', 'Evidence IDs must be unique')
  const evidenceIds = new Set<string>()
  for (const entry of evidence) {
    evidenceIds.add(entry.id)
    for (const hash of entry.trustedEnvelopeHashes) evidenceIds.add(`face-envelope:${hash}`)
    for (const untrusted of entry.untrusted) evidenceIds.add(`face-envelope:${untrusted.envelopeHash}`)
  }
  assertDomain(observations.every((entry) => entry.evidenceIds.every((id) => evidenceIds.has(id))), 'INVALID_RENDER_INPUT', 'An observation names evidence the set does not carry')
  const unknownRanges = item.unknownRanges.map((entry, index) => {
    const field = `unknownRanges[${index}]`
    const range = record(entry, field)
    exactAll(range, ['id', 'startFrame', 'endFrame', 'reasonCode', 'evidenceIds'], field)
    const startFrame = integer(range.startFrame, `${field}.startFrame`, 0, durationFrames - 1)
    const endFrame = integer(range.endFrame, `${field}.endFrame`, startFrame + 1, durationFrames)
    assertDomain(REFRAME_UNKNOWN_REASONS.includes(range.reasonCode as ReframeUnknownReason), 'INVALID_RENDER_INPUT', `${field}.reasonCode is invalid`)
    assertDomain(Array.isArray(range.evidenceIds) && range.evidenceIds.length <= 8 &&
      range.evidenceIds.every((id) => typeof id === 'string' && evidenceIds.has(id)), 'INVALID_RENDER_INPUT', `${field}.evidenceIds is invalid`)
    return Object.freeze({ id: identifier(range.id, `${field}.id`), startFrame, endFrame, reasonCode: range.reasonCode as ReframeUnknownReason,
      evidenceIds: Object.freeze([...range.evidenceIds as string[]]) })
  }).toSorted((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame || left.id.localeCompare(right.id))
  assertDomain(new Set(unknownRanges.map((entry) => entry.id)).size === unknownRanges.length, 'INVALID_RENDER_INPUT', 'Unknown range IDs must be unique')
  for (let index = 1; index < unknownRanges.length; index += 1) {
    assertDomain(unknownRanges[index]!.startFrame >= unknownRanges[index - 1]!.endFrame, 'INVALID_RENDER_INPUT', 'Unknown ranges cannot overlap')
  }
  // Evidence cannot both describe a range and declare it unknown: a contradiction would let the plan pick the kinder reading.
  assertDomain(observations.every((entry) => !unknownRanges.some((range) => entry.startFrame < range.endFrame && range.startFrame < entry.endFrame)),
    'INVALID_RENDER_INPUT', 'An observation overlaps a range declared unknown')
  const trackingBreaks = item.trackingBreaks.map((entry, index) => integer(entry, `trackingBreaks[${index}]`, 1, durationFrames - 1))
  assertDomain(trackingBreaks.every((entry, index) => index === 0 || entry > trackingBreaks[index - 1]!), 'INVALID_RENDER_INPUT', 'Tracking breaks must be strictly increasing')
  const parsed = Object.freeze({
    schemaVersion: 'reframe-observations/v2' as const, authority: 'server-owned' as const,
    id: identifier(item.id, 'observationSet.id'), sourceArtifactId: identifier(item.sourceArtifactId, 'observationSet.sourceArtifactId'),
    sourceManifestId: identifier(item.sourceManifestId, 'observationSet.sourceManifestId'),
    sourceSha256: sha256(item.sourceSha256, 'observationSet.sourceSha256'),
    sourceWidth: integer(item.sourceWidth, 'observationSet.sourceWidth', 2, 16_384),
    sourceHeight: integer(item.sourceHeight, 'observationSet.sourceHeight', 2, 16_384),
    fps: integer(item.fps, 'observationSet.fps', 1, 120), durationFrames,
    evidence: Object.freeze(evidence), roi: parseRoiAvailability(item.roi),
    observations: Object.freeze(observations), unknownRanges: Object.freeze(unknownRanges), trackingBreaks: Object.freeze(trackingBreaks),
    contentHash: typeof item.contentHash === 'string' ? item.contentHash : '',
  })
  const { contentHash, ...content } = parsed
  if (verifyHash) assertDomain(SHA256.test(contentHash) && contentHash === calculateCanonicalHash(content), 'INVALID_RENDER_INPUT', 'Observation set content hash is inconsistent')
  return parsed
}

export function parseReframeObservationSet(value: unknown, verifyHash = true): Readonly<ReframeObservationSet> {
  const item = record(value, 'observationSet')
  return item.schemaVersion === 'reframe-observations/v2'
    ? parseReframeObservationSetV2(value, verifyHash)
    : parseReframeObservationSetV1(value, verifyHash)
}

function parseOverrides(values: readonly unknown[] | undefined, format: OutputAspectRatio, sourceWidth: number, sourceHeight: number, durationFrames: number): readonly Readonly<ReframeManualOverrideV1>[] {
  const parsed = (values ?? []).map((value, index) => {
    const field = `overrides[${index}]`
    const item = record(value, field)
    exact(item, ['id', 'format', 'startFrame', 'endFrame', 'crop'], field)
    assertDomain(item.format === format, 'INVALID_RENDER_INPUT', 'Manual override format must match the requested variant', { requested: format, received: item.format })
    const startFrame = integer(item.startFrame, `${field}.startFrame`, 0, durationFrames - 1)
    const endFrame = integer(item.endFrame, `${field}.endFrame`, startFrame + 1, durationFrames)
    const crop = bounds(item.crop, `${field}.crop`)
    const expectedRatio = Number(format.split(':')[0]) / Number(format.split(':')[1])
    const actualRatio = crop.width * sourceWidth / (crop.height * sourceHeight)
    assertDomain(Math.abs(actualRatio - expectedRatio) <= 0.002, 'INVALID_RENDER_INPUT', 'Manual crop does not match the output aspect ratio', { actualRatio, expectedRatio })
    return Object.freeze({ id: identifier(item.id, `${field}.id`), format, startFrame, endFrame, crop })
  }).toSorted((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))
  for (let index = 1; index < parsed.length; index += 1) assertDomain(parsed[index].startFrame >= parsed[index - 1].endFrame, 'INVALID_RENDER_INPUT', 'Manual overrides cannot overlap')
  return Object.freeze(parsed)
}

/** The largest crop of the output's aspect ratio that fits the source frame, in normalized source units. */
export function maximumReframeCrop(format: OutputAspectRatio, sourceWidth: number, sourceHeight: number): Readonly<NormalizedBounds> {
  const target = Number(format.split(':')[0]) / Number(format.split(':')[1])
  const source = sourceWidth / sourceHeight
  return target <= source
    ? Object.freeze({ x: 0, y: 0, width: target / source, height: 1 })
    : Object.freeze({ x: 0, y: 0, width: 1, height: source / target })
}

export function centerReframeCrop(viewport: Readonly<NormalizedBounds>, centerX: number, centerY: number): Readonly<NormalizedBounds> {
  return Object.freeze({
    x: Math.max(0, Math.min(1 - viewport.width, centerX - viewport.width / 2)),
    y: Math.max(0, Math.min(1 - viewport.height, centerY - viewport.height / 2)),
    width: viewport.width, height: viewport.height,
  })
}

/** True when the crop is the whole source frame: nothing can be cut by it. */
export function reframeViewportIsWholeFrame(viewport: Readonly<NormalizedBounds>): boolean {
  return viewport.width >= 1 - 1e-9 && viewport.height >= 1 - 1e-9
}

const centerOf = (crop: Readonly<NormalizedBounds>) => ({ x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 })

function union(items: readonly Readonly<ReframeObservationV1>[]): Readonly<NormalizedBounds> {
  const x = Math.min(...items.map((item) => item.bounds.x)); const y = Math.min(...items.map((item) => item.bounds.y))
  const right = Math.max(...items.map((item) => item.bounds.x + item.bounds.width)); const bottom = Math.max(...items.map((item) => item.bounds.y + item.bounds.height))
  return Object.freeze({ x, y, width: right - x, height: bottom - y })
}

export function reframeCriticalVisible(crop: Readonly<NormalizedBounds>, observations: readonly Readonly<ReframeObservationV1>[], safeArea: { top: number; right: number; bottom: number; left: number }, margin: number): boolean {
  return observations.filter((item) => item.critical).every((item) =>
    item.bounds.x - margin >= crop.x + crop.width * safeArea.left - EPSILON &&
    item.bounds.y - margin >= crop.y + crop.height * safeArea.top - EPSILON &&
    item.bounds.x + item.bounds.width + margin <= crop.x + crop.width * (1 - safeArea.right) + EPSILON &&
    item.bounds.y + item.bounds.height + margin <= crop.y + crop.height * (1 - safeArea.bottom) + EPSILON)
}

/** Whether `crop` shows every subject with `margin` of normalized source units free on every side. */
export function reframeSubjectsVisible(crop: Readonly<NormalizedBounds>, observations: readonly Readonly<{ bounds: Readonly<NormalizedBounds> }>[], margin: number): boolean {
  return observations.every((item) =>
    item.bounds.x - margin >= crop.x - EPSILON && item.bounds.y - margin >= crop.y - EPSILON &&
    item.bounds.x + item.bounds.width + margin <= crop.x + crop.width + EPSILON &&
    item.bounds.y + item.bounds.height + margin <= crop.y + crop.height + EPSILON)
}

function clampMagnitude(vector: { x: number; y: number }, maximum: number): { x: number; y: number } {
  const magnitude = Math.hypot(vector.x, vector.y)
  if (magnitude <= maximum || magnitude === 0) return vector
  return { x: vector.x * maximum / magnitude, y: vector.y * maximum / magnitude }
}

/** Observations that must stay visible: the critical ones when there are any, otherwise all of them. */
export function reframeFocusedObservations<T extends Readonly<ReframeObservationV1>>(active: readonly T[]): readonly T[] {
  return active.some((item) => item.critical) ? active.filter((item) => item.critical) : active
}

type PlanInput = Readonly<{
  format: OutputAspectRatio
  observationSet: unknown
  overrides?: readonly unknown[]
  maxVelocityPerSecond?: number
  maxAccelerationPerSecondSquared?: number
  safetyMargin?: number
  /**
   * W66r. A plan sealed to the pinned `reframe-policy/v1` and decided on the variant's own sealed canvas. The limits come from the
   * policy (a caller cannot pass its own), the observations must be server-owned, and the result is `reframe-plan/v2`.
   */
  policy?: ReframePolicyV1
  variant?: Readonly<ReframeVariantCanvasV1>
}>

export function createReframePlan(input: PlanInput & { policy: ReframePolicyV1; variant: Readonly<ReframeVariantCanvasV1> }): Readonly<ReframePlanV2>
export function createReframePlan(input: PlanInput & { policy?: undefined; variant?: undefined }): Readonly<ReframePlanV1>
export function createReframePlan(input: PlanInput): Readonly<ReframePlan> {
  const observationSet = parseReframeObservationSet(input.observationSet)
  const strict = input.policy !== undefined
  if (strict) {
    assertDomain(isPinnedReframePolicy(input.policy), 'INVALID_RENDER_INPUT', 'Reframe policy is not the pinned reframe-policy/v1')
    assertDomain(input.variant !== undefined && observationSet.schemaVersion === 'reframe-observations/v2' && observationSet.authority === 'server-owned',
      'INVALID_RENDER_INPUT', 'A policy-sealed reframe plan requires server-owned observations and the variant it is decided for')
    assertDomain(input.maxVelocityPerSecond === undefined && input.maxAccelerationPerSecondSquared === undefined && input.safetyMargin === undefined,
      'INVALID_RENDER_INPUT', 'A policy-sealed reframe plan takes its limits from the policy, not from the caller')
  } else {
    assertDomain(input.variant === undefined, 'INVALID_RENDER_INPUT', 'A variant canvas requires a reframe policy')
  }
  const policy = input.policy
  const variant = input.variant
  const set2 = observationSet.schemaVersion === 'reframe-observations/v2' ? observationSet : undefined
  const preset = readOutputFormatPreset(input.format)
  if (variant) assertDomain(variant.aspectRatio === input.format, 'INVALID_RENDER_INPUT', 'Reframe variant aspect ratio does not match the requested format')
  const safeArea = variant ? variant.safeArea : preset.spec.safeArea
  const maxVelocity = policy ? policy.tracking.maxVelocityPerSecond : finite(input.maxVelocityPerSecond ?? 0.35, 'maxVelocityPerSecond', 0.01, 2)
  const maxAcceleration = policy ? policy.tracking.maxAccelerationPerSecondSquared : finite(input.maxAccelerationPerSecondSquared ?? 0.8, 'maxAccelerationPerSecondSquared', 0.01, 4)
  const margin = policy ? policy.tracking.safetyMargin : finite(input.safetyMargin ?? 0.02, 'safetyMargin', 0, 0.2)
  const minConfidence = policy ? policy.tracking.minObservationConfidence : 0.6
  const overrides = parseOverrides(input.overrides, input.format, observationSet.sourceWidth, observationSet.sourceHeight, observationSet.durationFrames)
  const unknownRanges = set2?.unknownRanges ?? []
  const baseBreaks = new Set<number>(set2?.trackingBreaks ?? [])
  // A manual range restarts the automatic tracking at its end: the picture steps from the editor's crop to the tracked one.
  const breaks = new Set<number>([...baseBreaks, ...(strict ? overrides.map((override) => override.endFrame).filter((frame) => frame < observationSet.durationFrames) : [])])
  const boundaries = [...new Set([0, observationSet.durationFrames,
    ...observationSet.observations.flatMap((item) => [item.startFrame, item.endFrame]),
    ...overrides.flatMap((item) => [item.startFrame, item.endFrame]),
    ...unknownRanges.flatMap((item) => [item.startFrame, item.endFrame]),
    ...breaks,
  ])].toSorted((left, right) => left - right)
  const viewport = maximumReframeCrop(input.format, observationSet.sourceWidth, observationSet.sourceHeight)
  // A crop that is the whole frame hides nothing, so no evidence is needed for it and nothing can be uncertain about it.
  const wholeFrame = strict && reframeViewportIsWholeFrame(viewport)
  const feasibleX = { min: viewport.width / 2, max: 1 - viewport.width / 2 }
  const feasibleY = { min: viewport.height / 2, max: 1 - viewport.height / 2 }
  const feasible = (point: { x: number; y: number }) => ({
    x: Math.max(feasibleX.min, Math.min(feasibleX.max, point.x)), y: Math.max(feasibleY.min, Math.min(feasibleY.max, point.y)),
  })
  const segments: ReframePlanSegmentV1[] = []
  const issues: (ReframePlanIssueV1 | ReframePlanIssueV2)[] = []
  const issue = (code: ReframePlanIssueV1['code'], startFrame: number, endFrame: number, observationIds: readonly string[],
    extra: Readonly<{ reasonCode: ReframePlanIssueV2['reasonCode']; evidenceIds: readonly string[] }>) => {
    const base = { code, format: input.format, startFrame, endFrame, observationIds: Object.freeze([...observationIds]) }
    issues.push(Object.freeze(strict ? { ...base, reasonCode: extra.reasonCode, evidenceIds: Object.freeze([...new Set(extra.evidenceIds)].toSorted()) } : base))
  }
  // Legacy dynamics (no policy): the state restarts at a fallback. Policy dynamics: it restarts only at a break, and a fallback is bridged.
  let previousCenter = { x: 0.5, y: 0.5 }; let previousVelocity = { x: 0, y: 0 }; let previousFrame = 0
  let tracked: { center: { x: number; y: number }; velocity: { x: number; y: number }; frame: number } | null = null
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startFrame = boundaries[index]; const endFrame = boundaries[index + 1]
    const active = observationSet.observations.filter((item) => item.startFrame <= startFrame && item.endFrame >= endFrame)
      .toSorted((left, right) => Number(right.critical) - Number(left.critical) || right.priority - left.priority || left.id.localeCompare(right.id))
    const evidenceOf = (items: readonly Readonly<ReframeObservationV1>[]) => items.flatMap((item) => ('evidenceIds' in item ? (item as ReframeObservationV2).evidenceIds : []))
    const manual = overrides.find((item) => item.startFrame <= startFrame && item.endFrame >= endFrame)
    const unknown = unknownRanges.find((item) => item.startFrame <= startFrame && item.endFrame >= endFrame)
    const uncertain = active.filter((item) => item.confidence < minConfidence)
    if (strict && (startFrame === 0 || breaks.has(startFrame))) tracked = null
    // A range the editor framed by hand is no longer uncertain: the decision is theirs.
    if (uncertain.length && !wholeFrame && !(strict && manual)) issue('PERCEPTION_UNCERTAIN', startFrame, endFrame, uncertain.map((item) => item.id), { reasonCode: 'LOW_CONFIDENCE', evidenceIds: evidenceOf(uncertain) })
    if (manual) {
      // A policy-sealed plan leaves this judgement to its caller (`reframeOverrideHidesSubject`), which can see where the server itself
      // could not fit the subjects and so may let the editor choose which one to lose; the legacy plan refuses any such crop.
      if (!strict) assertDomain(reframeCriticalVisible(manual.crop, active, safeArea, margin), 'INVALID_RENDER_INPUT', 'Manual override crops a critical subject or safe area')
      const center = centerOf(manual.crop)
      if (strict) {
        tracked = null
        segments.push(Object.freeze({ startFrame, endFrame, mode: 'crop', crop: manual.crop, source: 'manual', observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze({ x: 0, y: 0 }) }))
        continue
      }
      const dt = Math.max((startFrame - previousFrame) / observationSet.fps, 1 / observationSet.fps)
      previousVelocity = { x: (center.x - previousCenter.x) / dt, y: (center.y - previousCenter.y) / dt }; previousCenter = center; previousFrame = startFrame
      segments.push(Object.freeze({ startFrame, endFrame, mode: 'crop', crop: manual.crop, source: 'manual', observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze(previousVelocity) }))
      continue
    }
    if (wholeFrame) {
      // The whole frame is shown: no evidence is needed and no subject can be cut.
      segments.push(Object.freeze({ startFrame, endFrame, mode: 'crop', crop: viewport, source: active.length ? (reframeFocusedObservations(active).length > 1 ? 'multiple-subjects' : reframeFocusedObservations(active)[0]!.kind) : 'fallback',
        observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze({ x: 0, y: 0 }) }))
      continue
    }
    const fallback = (ids: readonly string[], activeForSegment: readonly Readonly<ReframeObservationV1>[]) => {
      segments.push(Object.freeze({ startFrame, endFrame, mode: 'contain', crop: null, source: 'fallback', observationIds: Object.freeze(ids), subjectIds: Object.freeze([...new Set(activeForSegment.map((item) => item.subjectId))]), velocity: Object.freeze({ x: 0, y: 0 }) }))
      if (!strict) { previousVelocity = { x: 0, y: 0 }; previousFrame = startFrame }
    }
    if (unknown) {
      issue('PERCEPTION_UNCERTAIN', startFrame, endFrame, [], { reasonCode: unknown.reasonCode, evidenceIds: unknown.evidenceIds })
      fallback([], [])
      continue
    }
    if (!active.length) {
      issue('NO_SUBJECT_OBSERVATION', startFrame, endFrame, [], { reasonCode: null, evidenceIds: [] })
      fallback([], [])
      continue
    }
    const focused = reframeFocusedObservations(active)
    const subjectBounds = union(focused)
    const rawDesired = { x: subjectBounds.x + subjectBounds.width / 2, y: subjectBounds.y + subjectBounds.height / 2 }
    const desiredCenter = strict ? feasible(rawDesired) : rawDesired
    let desiredCrop = centerReframeCrop(viewport, desiredCenter.x, desiredCenter.y)
    if (!reframeSubjectsVisible(desiredCrop, focused, margin) || !reframeCriticalVisible(desiredCrop, active, safeArea, margin)) {
      issue('SUBJECTS_DO_NOT_FIT', startFrame, endFrame, focused.map((item) => item.id), { reasonCode: null, evidenceIds: evidenceOf(focused) })
      fallback(active.map((item) => item.id), active)
      continue
    }
    let velocity: { x: number; y: number }
    let trackedCrop: Readonly<NormalizedBounds>
    if (strict) {
      if (tracked === null) {
        velocity = { x: 0, y: 0 }; trackedCrop = desiredCrop
      } else {
        const dt = Math.max((startFrame - tracked.frame) / observationSet.fps, 1 / observationSet.fps)
        const desiredVelocity = clampMagnitude({ x: (desiredCenter.x - tracked.center.x) / dt, y: (desiredCenter.y - tracked.center.y) / dt }, maxVelocity)
        const accelerationDelta = clampMagnitude({ x: desiredVelocity.x - tracked.velocity.x, y: desiredVelocity.y - tracked.velocity.y }, maxAcceleration * dt)
        const commanded = clampMagnitude({ x: tracked.velocity.x + accelerationDelta.x, y: tracked.velocity.y + accelerationDelta.y }, maxVelocity)
        trackedCrop = centerReframeCrop(viewport, tracked.center.x + commanded.x * dt, tracked.center.y + commanded.y * dt)
        // The velocity recorded is the one the crop actually has: the frame edge can only shorten a step, never lengthen it.
        const arrived = centerOf(trackedCrop)
        velocity = { x: (arrived.x - tracked.center.x) / dt, y: (arrived.y - tracked.center.y) / dt }
      }
    } else {
      const dt = Math.max((startFrame - previousFrame) / observationSet.fps, 1 / observationSet.fps)
      const desiredVelocity = clampMagnitude({ x: (desiredCenter.x - previousCenter.x) / dt, y: (desiredCenter.y - previousCenter.y) / dt }, maxVelocity)
      const accelerationDelta = clampMagnitude({ x: desiredVelocity.x - previousVelocity.x, y: desiredVelocity.y - previousVelocity.y }, maxAcceleration * dt)
      velocity = startFrame === 0
        ? { x: 0, y: 0 }
        : clampMagnitude({ x: previousVelocity.x + accelerationDelta.x, y: previousVelocity.y + accelerationDelta.y }, maxVelocity)
      const trackedCenter = startFrame === 0 ? desiredCenter : { x: previousCenter.x + velocity.x * dt, y: previousCenter.y + velocity.y * dt }
      trackedCrop = centerReframeCrop(viewport, trackedCenter.x, trackedCenter.y)
    }
    desiredCrop = trackedCrop
    if (!reframeSubjectsVisible(desiredCrop, focused, margin) || !reframeCriticalVisible(desiredCrop, active, safeArea, margin)) {
      issue('TRACKING_LIMIT_EXCEEDED', startFrame, endFrame, focused.map((item) => item.id), { reasonCode: null, evidenceIds: evidenceOf(focused) })
      fallback(active.map((item) => item.id), active)
      continue
    }
    if (strict) tracked = { center: centerOf(desiredCrop), velocity, frame: startFrame }
    else { previousCenter = centerOf(desiredCrop); previousVelocity = velocity; previousFrame = startFrame }
    segments.push(Object.freeze({ startFrame, endFrame, mode: 'crop', crop: desiredCrop, source: focused.length > 1 ? 'multiple-subjects' : focused[0].kind, observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze(velocity) }))
  }
  if (strict) {
    const body = Object.freeze({
      schemaVersion: 'reframe-plan/v2' as const, format: input.format, variant: Object.freeze({ ...variant!, safeArea: Object.freeze({ ...variant!.safeArea }) }),
      observationSetId: observationSet.id, observationSetHash: observationSet.contentHash,
      policyId: policy!.id, policyHash: REFRAME_POLICY_SHA256,
      maxVelocityPerSecond: maxVelocity, maxAccelerationPerSecondSquared: maxAcceleration, safetyMargin: margin,
      trackingBreaks: Object.freeze([...breaks].toSorted((left, right) => left - right)),
      segments: Object.freeze(segments), issues: Object.freeze(issues as ReframePlanIssueV2[]),
    })
    const plan = Object.freeze({ ...body, planHash: calculateCanonicalHash(body) })
    validateReframePlan(plan, observationSet)
    return plan
  }
  const body = Object.freeze({
    schemaVersion: 'reframe-plan/v1' as const, format: input.format, observationSetId: observationSet.id, observationSetHash: observationSet.contentHash,
    outputFormatRegistryHash: OUTPUT_FORMAT_REGISTRY.registryHash, outputPresetHash: preset.presetHash,
    maxVelocityPerSecond: maxVelocity, maxAccelerationPerSecondSquared: maxAcceleration, safetyMargin: margin,
    segments: Object.freeze(segments), issues: Object.freeze(issues as ReframePlanIssueV1[]),
  })
  const plan = Object.freeze({ ...body, planHash: calculateCanonicalHash(body) })
  validateReframePlan(plan, observationSet)
  return plan
}

/** True when the crop touches a frame edge along an axis it could still slide on: a hard stop, not a smoothed one. */
function touchesFrameEdge(crop: Readonly<NormalizedBounds>): boolean {
  const slideX = 1 - crop.width > 1e-9, slideY = 1 - crop.height > 1e-9
  return (slideX && (crop.x <= 1e-9 || crop.x + crop.width >= 1 - 1e-9)) || (slideY && (crop.y <= 1e-9 || crop.y + crop.height >= 1 - 1e-9))
}

export function validateReframePlan(plan: Readonly<ReframePlan>, observationSetValue: unknown): void {
  const observationSet = parseReframeObservationSet(observationSetValue)
  const strict = plan.schemaVersion === 'reframe-plan/v2'
  assertDomain(plan.schemaVersion === 'reframe-plan/v1' || strict, 'INVALID_RENDER_INPUT', 'Reframe plan schema version is unsupported')
  const preset = readOutputFormatPreset(plan.format)
  assertDomain(plan.observationSetId === observationSet.id && plan.observationSetHash === observationSet.contentHash, 'INVALID_RENDER_INPUT', 'Reframe plan observation identity is inconsistent')
  let safeArea: Readonly<NormalizedInsets> = preset.spec.safeArea
  let trackingBreaks = new Set<number>()
  if (plan.schemaVersion === 'reframe-plan/v2') {
    assertDomain(observationSet.schemaVersion === 'reframe-observations/v2' && observationSet.authority === 'server-owned',
      'INVALID_RENDER_INPUT', 'A policy-sealed reframe plan can only describe server-owned observations')
    assertDomain(plan.policyHash === REFRAME_POLICY_SHA256 && plan.policyId === REFRAME_POLICY.id &&
      plan.maxVelocityPerSecond === REFRAME_POLICY.tracking.maxVelocityPerSecond &&
      plan.maxAccelerationPerSecondSquared === REFRAME_POLICY.tracking.maxAccelerationPerSecondSquared &&
      plan.safetyMargin === REFRAME_POLICY.tracking.safetyMargin,
    'INVALID_RENDER_INPUT', 'Reframe plan is not sealed to the pinned reframe policy')
    assertDomain(plan.variant.aspectRatio === plan.format && ID.test(plan.variant.variantId) && SHA256.test(plan.variant.specHash), 'INVALID_RENDER_INPUT', 'Reframe plan variant identity is invalid')
    safeArea = plan.variant.safeArea
    trackingBreaks = new Set(plan.trackingBreaks)
    assertDomain(plan.trackingBreaks.every((frame, position) => Number.isSafeInteger(frame) && frame > 0 && frame < observationSet.durationFrames && (position === 0 || frame > plan.trackingBreaks[position - 1]!)),
      'INVALID_RENDER_INPUT', 'Reframe plan tracking breaks are invalid')
    assertDomain((observationSet.trackingBreaks as readonly number[]).every((frame) => trackingBreaks.has(frame)), 'INVALID_RENDER_INPUT', 'Reframe plan dropped a cut of its observations')
  } else {
    assertDomain(plan.outputFormatRegistryHash === OUTPUT_FORMAT_REGISTRY.registryHash && plan.outputPresetHash === preset.presetHash, 'INVALID_RENDER_INPUT', 'Reframe plan output registry identity is inconsistent')
  }
  const { planHash, ...body } = plan
  assertDomain(SHA256.test(planHash) && planHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Reframe plan hash is inconsistent')
  assertDomain(plan.segments.length > 0 && plan.segments.length <= MAX_SEGMENTS, 'INVALID_RENDER_INPUT', 'Reframe plan segments are invalid')
  const viewport = maximumReframeCrop(plan.format, observationSet.sourceWidth, observationSet.sourceHeight)
  const wholeFrame = strict && reframeViewportIsWholeFrame(viewport)
  let cursor = 0
  let previousAutomatic: Readonly<{ velocity: Readonly<{ x: number; y: number }>; frame: number; crop: Readonly<NormalizedBounds> }> | undefined
  let previousAutomaticFrame: number | undefined
  let previousAutomaticVelocity: Readonly<{ x: number; y: number }> | undefined
  for (const segment of plan.segments) {
    assertDomain(segment.startFrame === cursor && segment.endFrame > segment.startFrame && segment.endFrame <= observationSet.durationFrames, 'INVALID_RENDER_INPUT', 'Reframe plan timeline is not continuous')
    assertDomain(Number.isFinite(segment.velocity.x) && Number.isFinite(segment.velocity.y), 'INVALID_RENDER_INPUT', 'Reframe plan velocity is invalid')
    const active = observationSet.observations.filter((item) => item.startFrame <= segment.startFrame && item.endFrame >= segment.endFrame)
    if (strict && (segment.startFrame === 0 || trackingBreaks.has(segment.startFrame))) previousAutomatic = undefined
    if (segment.mode === 'contain') {
      assertDomain(segment.crop === null && segment.source === 'fallback', 'INVALID_RENDER_INPUT', 'Contain fallback cannot declare a crop')
      if (!strict) { previousAutomaticVelocity = undefined; previousAutomaticFrame = undefined }
    } else {
      assertDomain(segment.crop !== null, 'INVALID_RENDER_INPUT', 'Crop segment requires normalized crop bounds')
      const crop = bounds(segment.crop, 'segment.crop')
      const expectedRatio = Number(plan.format.split(':')[0]) / Number(plan.format.split(':')[1])
      const actualRatio = crop.width * observationSet.sourceWidth / (crop.height * observationSet.sourceHeight)
      assertDomain(Math.abs(actualRatio - expectedRatio) <= 0.002, 'INVALID_RENDER_INPUT', 'Reframe crop aspect is invalid')
      if (!wholeFrame && !(strict && segment.source === 'manual')) assertDomain(reframeCriticalVisible(crop, active, safeArea, plan.safetyMargin), 'INVALID_RENDER_INPUT', 'Reframe crop hides a critical subject or violates safe area')
      if (segment.source !== 'manual') {
        const focused = reframeFocusedObservations(active)
        if (!wholeFrame) assertDomain(reframeSubjectsVisible(crop, focused, plan.safetyMargin), 'INVALID_RENDER_INPUT', 'Reframe crop hides its tracked subject')
        assertDomain(Math.hypot(segment.velocity.x, segment.velocity.y) <= plan.maxVelocityPerSecond + EPSILON, 'INVALID_RENDER_INPUT', 'Reframe tracking velocity exceeds its limit')
        if (strict) {
          // The velocity is recomputed from the crops: the figure a plan states about itself is never trusted.
          if (previousAutomatic) {
            const dt = Math.max((segment.startFrame - previousAutomatic.frame) / observationSet.fps, 1 / observationSet.fps)
            const from = centerOf(previousAutomatic.crop), to = centerOf(crop)
            const measured = { x: (to.x - from.x) / dt, y: (to.y - from.y) / dt }
            assertDomain(Math.abs(measured.x - segment.velocity.x) <= 1e-6 && Math.abs(measured.y - segment.velocity.y) <= 1e-6,
              'INVALID_RENDER_INPUT', 'Reframe tracking velocity differs from the crops it connects')
            assertDomain(Math.hypot(measured.x, measured.y) <= plan.maxVelocityPerSecond + EPSILON, 'INVALID_RENDER_INPUT', 'Reframe tracking velocity exceeds its limit')
            const stopped = touchesFrameEdge(crop) || touchesFrameEdge(previousAutomatic.crop)
            if (!stopped) {
              assertDomain(Math.hypot(measured.x - previousAutomatic.velocity.x, measured.y - previousAutomatic.velocity.y) <= plan.maxAccelerationPerSecondSquared * dt + EPSILON,
                'INVALID_RENDER_INPUT', 'Reframe tracking acceleration exceeds its limit')
            }
          } else {
            assertDomain(segment.velocity.x === 0 && segment.velocity.y === 0, 'INVALID_RENDER_INPUT', 'A restarted tracking segment starts at rest')
          }
          previousAutomatic = Object.freeze({ velocity: segment.velocity, frame: segment.startFrame, crop })
        } else {
          if (previousAutomaticVelocity && previousAutomaticFrame !== undefined) {
            const dt = Math.max((segment.startFrame - previousAutomaticFrame) / observationSet.fps, 1 / observationSet.fps)
            assertDomain(Math.hypot(segment.velocity.x - previousAutomaticVelocity.x, segment.velocity.y - previousAutomaticVelocity.y) <= plan.maxAccelerationPerSecondSquared * dt + EPSILON, 'INVALID_RENDER_INPUT', 'Reframe tracking acceleration exceeds its limit')
          }
          previousAutomaticVelocity = segment.velocity
          previousAutomaticFrame = segment.startFrame
        }
      } else {
        if (strict) previousAutomatic = undefined
        previousAutomaticVelocity = undefined
        previousAutomaticFrame = undefined
      }
    }
    cursor = segment.endFrame
  }
  assertDomain(cursor === observationSet.durationFrames, 'INVALID_RENDER_INPUT', 'Reframe plan does not cover the observation duration')
}

export const REFRAME_OBSERVATION_FIXTURES = Object.freeze({
  onePerson: Object.freeze([{ id: 'roi-person-1', subjectId: 'person-1', kind: 'face', startFrame: 0, endFrame: 90, bounds: { x: 0.42, y: 0.2, width: 0.16, height: 0.24 }, confidence: 0.98, priority: 100, critical: true }]),
  twoPeople: Object.freeze([
    { id: 'roi-person-left', subjectId: 'person-left', kind: 'face', startFrame: 0, endFrame: 90, bounds: { x: 0.39, y: 0.22, width: 0.08, height: 0.22 }, confidence: 0.96, priority: 100, critical: true },
    { id: 'roi-person-right', subjectId: 'person-right', kind: 'face', startFrame: 0, endFrame: 90, bounds: { x: 0.51, y: 0.22, width: 0.08, height: 0.22 }, confidence: 0.95, priority: 100, critical: true },
  ]),
  screen: Object.freeze([{ id: 'roi-screen-1', subjectId: 'screen-1', kind: 'screen', startFrame: 0, endFrame: 90, bounds: { x: 0.18, y: 0.15, width: 0.64, height: 0.55 }, confidence: 0.99, priority: 90, critical: true }]),
  movingObject: Object.freeze([
    { id: 'roi-object-a', subjectId: 'object-1', kind: 'object', startFrame: 0, endFrame: 30, bounds: { x: 0.38, y: 0.4, width: 0.1, height: 0.1 }, confidence: 0.91, priority: 80, critical: false },
    { id: 'roi-object-b', subjectId: 'object-1', kind: 'object', startFrame: 30, endFrame: 60, bounds: { x: 0.43, y: 0.4, width: 0.1, height: 0.1 }, confidence: 0.89, priority: 80, critical: false },
    { id: 'roi-object-c', subjectId: 'object-1', kind: 'object', startFrame: 60, endFrame: 90, bounds: { x: 0.48, y: 0.4, width: 0.1, height: 0.1 }, confidence: 0.87, priority: 80, critical: false },
  ]),
})
