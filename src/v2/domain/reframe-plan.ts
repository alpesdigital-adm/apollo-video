import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { OUTPUT_FORMAT_REGISTRY, readOutputFormatPreset } from './output-format-registry.ts'
import type { NormalizedBounds, OutputAspectRatio } from './output-spec.ts'

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

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const EPSILON = 1e-7

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  assertDomain(unknown.length === 0, 'INVALID_RENDER_INPUT', `${field} contains unsupported fields`, { fields: unknown })
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

function parseObservation(value: unknown, index: number, durationFrames: number): Readonly<ReframeObservationV1> {
  const field = `observations[${index}]`
  const item = record(value, field)
  exact(item, ['id', 'subjectId', 'kind', 'startFrame', 'endFrame', 'bounds', 'confidence', 'priority', 'critical'], field)
  const startFrame = integer(item.startFrame, `${field}.startFrame`, 0, durationFrames - 1)
  const endFrame = integer(item.endFrame, `${field}.endFrame`, startFrame + 1, durationFrames)
  assertDomain(typeof item.kind === 'string' && REFRAME_ROI_KINDS.includes(item.kind as ReframeRoiKind), 'INVALID_RENDER_INPUT', `${field}.kind is invalid`)
  assertDomain(typeof item.critical === 'boolean', 'INVALID_RENDER_INPUT', `${field}.critical is invalid`)
  return Object.freeze({
    id: identifier(item.id, `${field}.id`), subjectId: identifier(item.subjectId, `${field}.subjectId`),
    kind: item.kind as ReframeRoiKind, startFrame, endFrame, bounds: bounds(item.bounds, `${field}.bounds`),
    confidence: finite(item.confidence, `${field}.confidence`, 0, 1),
    priority: integer(item.priority, `${field}.priority`, 0, 100), critical: item.critical,
  })
}

export function createReframeObservationSet(input: Omit<ReframeObservationSetV1, 'schemaVersion' | 'contentHash'>): Readonly<ReframeObservationSetV1> {
  const body = parseReframeObservationSet({ ...input, schemaVersion: 'reframe-observations/v1', contentHash: '0'.repeat(64) }, false)
  const { contentHash: _contentHash, ...content } = body
  return Object.freeze({ ...content, contentHash: calculateCanonicalHash(content) })
}

export function parseReframeObservationSet(value: unknown, verifyHash = true): Readonly<ReframeObservationSetV1> {
  const item = record(value, 'observationSet')
  exact(item, ['schemaVersion', 'id', 'sourceArtifactId', 'sourceManifestId', 'sourceSha256', 'sourceWidth', 'sourceHeight', 'fps', 'durationFrames', 'observations', 'contentHash'], 'observationSet')
  assertDomain(item.schemaVersion === 'reframe-observations/v1', 'INVALID_RENDER_INPUT', 'Observation set schema version is unsupported')
  const durationFrames = integer(item.durationFrames, 'observationSet.durationFrames', 1, 2_592_000)
  assertDomain(Array.isArray(item.observations) && item.observations.length > 0 && item.observations.length <= 10_000, 'INVALID_RENDER_INPUT', 'Observation set observations are invalid')
  const observations = item.observations.map((entry, index) => parseObservation(entry, index, durationFrames))
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

function maximumCrop(format: OutputAspectRatio, sourceWidth: number, sourceHeight: number): Readonly<NormalizedBounds> {
  const target = Number(format.split(':')[0]) / Number(format.split(':')[1])
  const source = sourceWidth / sourceHeight
  return target <= source
    ? Object.freeze({ x: 0, y: 0, width: target / source, height: 1 })
    : Object.freeze({ x: 0, y: 0, width: 1, height: source / target })
}

function centerCrop(viewport: Readonly<NormalizedBounds>, centerX: number, centerY: number): Readonly<NormalizedBounds> {
  return Object.freeze({
    x: Math.max(0, Math.min(1 - viewport.width, centerX - viewport.width / 2)),
    y: Math.max(0, Math.min(1 - viewport.height, centerY - viewport.height / 2)),
    width: viewport.width, height: viewport.height,
  })
}

function union(items: readonly Readonly<ReframeObservationV1>[]): Readonly<NormalizedBounds> {
  const x = Math.min(...items.map((item) => item.bounds.x)); const y = Math.min(...items.map((item) => item.bounds.y))
  const right = Math.max(...items.map((item) => item.bounds.x + item.bounds.width)); const bottom = Math.max(...items.map((item) => item.bounds.y + item.bounds.height))
  return Object.freeze({ x, y, width: right - x, height: bottom - y })
}

function criticalVisible(crop: Readonly<NormalizedBounds>, observations: readonly Readonly<ReframeObservationV1>[], safeArea: { top: number; right: number; bottom: number; left: number }, margin: number): boolean {
  return observations.filter((item) => item.critical).every((item) =>
    item.bounds.x - margin >= crop.x + crop.width * safeArea.left - EPSILON &&
    item.bounds.y - margin >= crop.y + crop.height * safeArea.top - EPSILON &&
    item.bounds.x + item.bounds.width + margin <= crop.x + crop.width * (1 - safeArea.right) + EPSILON &&
    item.bounds.y + item.bounds.height + margin <= crop.y + crop.height * (1 - safeArea.bottom) + EPSILON)
}

function subjectsVisible(crop: Readonly<NormalizedBounds>, observations: readonly Readonly<ReframeObservationV1>[], margin: number): boolean {
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

export function createReframePlan(input: {
  format: OutputAspectRatio
  observationSet: unknown
  overrides?: readonly unknown[]
  maxVelocityPerSecond?: number
  maxAccelerationPerSecondSquared?: number
  safetyMargin?: number
}): Readonly<ReframePlanV1> {
  const observationSet = parseReframeObservationSet(input.observationSet)
  const preset = readOutputFormatPreset(input.format)
  const maxVelocity = finite(input.maxVelocityPerSecond ?? 0.35, 'maxVelocityPerSecond', 0.01, 2)
  const maxAcceleration = finite(input.maxAccelerationPerSecondSquared ?? 0.8, 'maxAccelerationPerSecondSquared', 0.01, 4)
  const margin = finite(input.safetyMargin ?? 0.02, 'safetyMargin', 0, 0.2)
  const overrides = parseOverrides(input.overrides, input.format, observationSet.sourceWidth, observationSet.sourceHeight, observationSet.durationFrames)
  const boundaries = [...new Set([0, observationSet.durationFrames,
    ...observationSet.observations.flatMap((item) => [item.startFrame, item.endFrame]),
    ...overrides.flatMap((item) => [item.startFrame, item.endFrame]),
  ])].toSorted((left, right) => left - right)
  const viewport = maximumCrop(input.format, observationSet.sourceWidth, observationSet.sourceHeight)
  const segments: ReframePlanSegmentV1[] = []
  const issues: ReframePlanIssueV1[] = []
  let previousCenter = { x: 0.5, y: 0.5 }; let previousVelocity = { x: 0, y: 0 }; let previousFrame = 0
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startFrame = boundaries[index]; const endFrame = boundaries[index + 1]
    const active = observationSet.observations.filter((item) => item.startFrame <= startFrame && item.endFrame >= endFrame)
      .toSorted((left, right) => Number(right.critical) - Number(left.critical) || right.priority - left.priority || left.id.localeCompare(right.id))
    const manual = overrides.find((item) => item.startFrame <= startFrame && item.endFrame >= endFrame)
    const uncertain = active.filter((item) => item.confidence < 0.6)
    if (uncertain.length) issues.push(Object.freeze({ code: 'PERCEPTION_UNCERTAIN', format: input.format, startFrame, endFrame, observationIds: Object.freeze(uncertain.map((item) => item.id)) }))
    if (manual) {
      assertDomain(criticalVisible(manual.crop, active, preset.spec.safeArea, margin), 'INVALID_RENDER_INPUT', 'Manual override crops a critical subject or safe area')
      const center = { x: manual.crop.x + manual.crop.width / 2, y: manual.crop.y + manual.crop.height / 2 }
      const dt = Math.max((startFrame - previousFrame) / observationSet.fps, 1 / observationSet.fps)
      previousVelocity = { x: (center.x - previousCenter.x) / dt, y: (center.y - previousCenter.y) / dt }; previousCenter = center; previousFrame = startFrame
      segments.push(Object.freeze({ startFrame, endFrame, mode: 'crop', crop: manual.crop, source: 'manual', observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze(previousVelocity) }))
      continue
    }
    if (!active.length) {
      issues.push(Object.freeze({ code: 'NO_SUBJECT_OBSERVATION', format: input.format, startFrame, endFrame, observationIds: Object.freeze([]) }))
      segments.push(Object.freeze({ startFrame, endFrame, mode: 'contain', crop: null, source: 'fallback', observationIds: Object.freeze([]), subjectIds: Object.freeze([]), velocity: Object.freeze({ x: 0, y: 0 }) }))
      previousVelocity = { x: 0, y: 0 }; previousFrame = startFrame
      continue
    }
    const focused = active.some((item) => item.critical) ? active.filter((item) => item.critical) : active
    const subjectBounds = union(focused)
    const desiredCenter = { x: subjectBounds.x + subjectBounds.width / 2, y: subjectBounds.y + subjectBounds.height / 2 }
    let desiredCrop = centerCrop(viewport, desiredCenter.x, desiredCenter.y)
    if (!subjectsVisible(desiredCrop, focused, margin) || !criticalVisible(desiredCrop, active, preset.spec.safeArea, margin)) {
      issues.push(Object.freeze({ code: 'SUBJECTS_DO_NOT_FIT', format: input.format, startFrame, endFrame, observationIds: Object.freeze(focused.map((item) => item.id)) }))
      segments.push(Object.freeze({ startFrame, endFrame, mode: 'contain', crop: null, source: 'fallback', observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze({ x: 0, y: 0 }) }))
      previousVelocity = { x: 0, y: 0 }; previousFrame = startFrame
      continue
    }
    const dt = Math.max((startFrame - previousFrame) / observationSet.fps, 1 / observationSet.fps)
    const desiredVelocity = clampMagnitude({ x: (desiredCenter.x - previousCenter.x) / dt, y: (desiredCenter.y - previousCenter.y) / dt }, maxVelocity)
    const accelerationDelta = clampMagnitude({ x: desiredVelocity.x - previousVelocity.x, y: desiredVelocity.y - previousVelocity.y }, maxAcceleration * dt)
    const velocity = startFrame === 0
      ? { x: 0, y: 0 }
      : clampMagnitude({ x: previousVelocity.x + accelerationDelta.x, y: previousVelocity.y + accelerationDelta.y }, maxVelocity)
    const trackedCenter = startFrame === 0 ? desiredCenter : { x: previousCenter.x + velocity.x * dt, y: previousCenter.y + velocity.y * dt }
    desiredCrop = centerCrop(viewport, trackedCenter.x, trackedCenter.y)
    if (!subjectsVisible(desiredCrop, focused, margin) || !criticalVisible(desiredCrop, active, preset.spec.safeArea, margin)) {
      issues.push(Object.freeze({ code: 'TRACKING_LIMIT_EXCEEDED', format: input.format, startFrame, endFrame, observationIds: Object.freeze(focused.map((item) => item.id)) }))
      segments.push(Object.freeze({ startFrame, endFrame, mode: 'contain', crop: null, source: 'fallback', observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze({ x: 0, y: 0 }) }))
      previousVelocity = { x: 0, y: 0 }; previousFrame = startFrame
      continue
    }
    previousCenter = { x: desiredCrop.x + desiredCrop.width / 2, y: desiredCrop.y + desiredCrop.height / 2 }; previousVelocity = velocity; previousFrame = startFrame
    segments.push(Object.freeze({ startFrame, endFrame, mode: 'crop', crop: desiredCrop, source: focused.length > 1 ? 'multiple-subjects' : focused[0].kind, observationIds: Object.freeze(active.map((item) => item.id)), subjectIds: Object.freeze([...new Set(active.map((item) => item.subjectId))]), velocity: Object.freeze(velocity) }))
  }
  const body = Object.freeze({
    schemaVersion: 'reframe-plan/v1' as const, format: input.format, observationSetId: observationSet.id, observationSetHash: observationSet.contentHash,
    outputFormatRegistryHash: OUTPUT_FORMAT_REGISTRY.registryHash, outputPresetHash: preset.presetHash,
    maxVelocityPerSecond: maxVelocity, maxAccelerationPerSecondSquared: maxAcceleration, safetyMargin: margin,
    segments: Object.freeze(segments), issues: Object.freeze(issues),
  })
  const plan = Object.freeze({ ...body, planHash: calculateCanonicalHash(body) })
  validateReframePlan(plan, observationSet)
  return plan
}

export function validateReframePlan(plan: Readonly<ReframePlanV1>, observationSetValue: unknown): void {
  const observationSet = parseReframeObservationSet(observationSetValue)
  const preset = readOutputFormatPreset(plan.format)
  assertDomain(plan.schemaVersion === 'reframe-plan/v1', 'INVALID_RENDER_INPUT', 'Reframe plan schema version is unsupported')
  assertDomain(plan.observationSetId === observationSet.id && plan.observationSetHash === observationSet.contentHash, 'INVALID_RENDER_INPUT', 'Reframe plan observation identity is inconsistent')
  assertDomain(plan.outputFormatRegistryHash === OUTPUT_FORMAT_REGISTRY.registryHash && plan.outputPresetHash === preset.presetHash, 'INVALID_RENDER_INPUT', 'Reframe plan output registry identity is inconsistent')
  const { planHash, ...body } = plan
  assertDomain(SHA256.test(planHash) && planHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Reframe plan hash is inconsistent')
  assertDomain(plan.segments.length > 0 && plan.segments.length <= 20_000, 'INVALID_RENDER_INPUT', 'Reframe plan segments are invalid')
  let cursor = 0
  let previousAutomaticVelocity: Readonly<{ x: number; y: number }> | undefined
  let previousAutomaticFrame: number | undefined
  for (const segment of plan.segments) {
    assertDomain(segment.startFrame === cursor && segment.endFrame > segment.startFrame && segment.endFrame <= observationSet.durationFrames, 'INVALID_RENDER_INPUT', 'Reframe plan timeline is not continuous')
    assertDomain(Number.isFinite(segment.velocity.x) && Number.isFinite(segment.velocity.y), 'INVALID_RENDER_INPUT', 'Reframe plan velocity is invalid')
    const active = observationSet.observations.filter((item) => item.startFrame <= segment.startFrame && item.endFrame >= segment.endFrame)
    if (segment.mode === 'contain') {
      assertDomain(segment.crop === null && segment.source === 'fallback', 'INVALID_RENDER_INPUT', 'Contain fallback cannot declare a crop')
      previousAutomaticVelocity = undefined
      previousAutomaticFrame = undefined
    } else {
      assertDomain(segment.crop !== null, 'INVALID_RENDER_INPUT', 'Crop segment requires normalized crop bounds')
      const crop = bounds(segment.crop, 'segment.crop')
      const expectedRatio = Number(plan.format.split(':')[0]) / Number(plan.format.split(':')[1])
      const actualRatio = crop.width * observationSet.sourceWidth / (crop.height * observationSet.sourceHeight)
      assertDomain(Math.abs(actualRatio - expectedRatio) <= 0.002, 'INVALID_RENDER_INPUT', 'Reframe crop aspect is invalid')
      assertDomain(criticalVisible(crop, active, preset.spec.safeArea, plan.safetyMargin), 'INVALID_RENDER_INPUT', 'Reframe crop hides a critical subject or violates safe area')
      if (segment.source !== 'manual') {
        const focused = active.some((item) => item.critical) ? active.filter((item) => item.critical) : active
        assertDomain(subjectsVisible(crop, focused, plan.safetyMargin), 'INVALID_RENDER_INPUT', 'Reframe crop hides its tracked subject')
        assertDomain(Math.hypot(segment.velocity.x, segment.velocity.y) <= plan.maxVelocityPerSecond + EPSILON, 'INVALID_RENDER_INPUT', 'Reframe tracking velocity exceeds its limit')
        if (previousAutomaticVelocity && previousAutomaticFrame !== undefined) {
          const dt = Math.max((segment.startFrame - previousAutomaticFrame) / observationSet.fps, 1 / observationSet.fps)
          assertDomain(Math.hypot(segment.velocity.x - previousAutomaticVelocity.x, segment.velocity.y - previousAutomaticVelocity.y) <= plan.maxAccelerationPerSecondSquared * dt + EPSILON, 'INVALID_RENDER_INPUT', 'Reframe tracking acceleration exceeds its limit')
        }
        previousAutomaticVelocity = segment.velocity
        previousAutomaticFrame = segment.startFrame
      } else {
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
