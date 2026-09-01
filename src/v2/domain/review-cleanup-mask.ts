import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import type { ReviewAnnotation } from './review-system.ts'
import {
  assertTransformationBrief,
  type TransformationBrief,
  type TransformationSafeZone,
} from './transformation-brief.ts'

export const REVIEW_CLEANUP_MASK_SCHEMA_VERSION = 'review-cleanup-mask/v1' as const
export const REVIEW_CLEANUP_MASK_POLICY_VERSION = 'review-cleanup-mask-policy/v1' as const

export const REVIEW_CLEANUP_MASK_TRACKING_STATUSES = Object.freeze([
  'static',
  'tracked',
  'uncertain',
] as const)
export type ReviewCleanupMaskTrackingStatus =
  (typeof REVIEW_CLEANUP_MASK_TRACKING_STATUSES)[number]

export interface NormalizedMaskRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface ReviewCleanupMaskFormat {
  outputSpecId: string
  width: number
  height: number
}

export interface ReviewCleanupMaskKeyframe {
  frame: number
  region: Readonly<NormalizedMaskRegion>
}

export interface ReviewCleanupMask {
  schemaVersion: typeof REVIEW_CLEANUP_MASK_SCHEMA_VERSION
  policyVersion: typeof REVIEW_CLEANUP_MASK_POLICY_VERSION
  id: string
  rootId: string
  revision: number
  supersedesId?: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  annotationId: string
  annotationHash: string
  proxyArtifactId: string
  proxyHash: string
  sourceArtifactId: string
  sourceArtifactHash: string
  transformationBriefId: string
  transformationBriefHash: string
  format: Readonly<ReviewCleanupMaskFormat>
  range: Readonly<{ startFrame: number; endFrame: number }>
  region: Readonly<NormalizedMaskRegion>
  keyframes: readonly Readonly<ReviewCleanupMaskKeyframe>[]
  preserveRegions: readonly Readonly<{
    purpose: TransformationSafeZone['purpose']
    region: Readonly<NormalizedMaskRegion>
  }>[]
  tracking: Readonly<{
    status: ReviewCleanupMaskTrackingStatus
    confidenceBps: number
  }>
  formatChange: Readonly<{
    sourceOutputSpecId: string
    acknowledged: boolean
  }> | null
  createdByClientId: string
  createdAt: string
  maskHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function uuid(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && UUID.test(value), 'INVALID_ARGUMENT', `${field} must be a UUID`)
  return value.toLowerCase()
}

function instant(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  assertDomain(Number.isFinite(parsed.getTime()), 'INVALID_ARGUMENT', `${field} is invalid`)
  return parsed.toISOString()
}

function basisPoints(value: unknown, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000,
    'INVALID_ARGUMENT',
    `${field} must be an integer between zero and 10000`,
  )
  return Number(value)
}

function normalizedRegion(
  value: Readonly<NormalizedMaskRegion>,
  field: string,
): Readonly<NormalizedMaskRegion> {
  const values = [value?.x, value?.y, value?.width, value?.height]
  assertDomain(
    values.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
      value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 &&
      value.x + value.width <= 1 && value.y + value.height <= 1,
    'INVALID_ARGUMENT',
    `${field} must be a positive normalized rectangle`,
  )
  return Object.freeze({
    x: Number(value.x.toFixed(6)),
    y: Number(value.y.toFixed(6)),
    width: Number(value.width.toFixed(6)),
    height: Number(value.height.toFixed(6)),
  })
}

function overlaps(
  left: Readonly<NormalizedMaskRegion>,
  right: Readonly<NormalizedMaskRegion>,
): boolean {
  return Math.max(left.x, right.x) < Math.min(left.x + left.width, right.x + right.width) &&
    Math.max(left.y, right.y) < Math.min(left.y + left.height, right.y + right.height)
}

function annotationContent(annotation: Readonly<ReviewAnnotation>) {
  return {
    id: annotation.id,
    projectVersionId: annotation.projectVersionId,
    proxyArtifactId: annotation.proxyArtifactId,
    proxyHash: annotation.proxyHash,
    frame: annotation.frame,
    timeRangeMs: annotation.timeRangeMs,
    scope: annotation.scope,
    region: annotation.region,
    targetIds: annotation.targetIds,
    applicationScope: annotation.applicationScope,
    affectedCount: annotation.affectedCount,
    text: annotation.text,
    author: annotation.author,
    status: annotation.status,
    createdAt: annotation.createdAt,
  }
}

export function calculateReviewAnnotationHash(
  annotation: Readonly<ReviewAnnotation>,
): string {
  return calculateCanonicalHash(annotationContent(annotation))
}

function format(value: Readonly<ReviewCleanupMaskFormat>): Readonly<ReviewCleanupMaskFormat> {
  assertDomain(
    Number.isSafeInteger(value.width) && value.width > 0 && value.width <= 16_384 &&
      Number.isSafeInteger(value.height) && value.height > 0 && value.height <= 16_384,
    'INVALID_ARGUMENT',
    'mask format dimensions are invalid',
  )
  return Object.freeze({
    outputSpecId: identity(value.outputSpecId, 'format.outputSpecId'),
    width: value.width,
    height: value.height,
  })
}

function canonicalKeyframes(input: {
  keyframes: readonly Readonly<ReviewCleanupMaskKeyframe>[]
  range: Readonly<{ startFrame: number; endFrame: number }>
  defaultRegion: Readonly<NormalizedMaskRegion>
}): readonly Readonly<ReviewCleanupMaskKeyframe>[] {
  assertDomain(input.keyframes.length >= 1 && input.keyframes.length <= 240, 'INVALID_ARGUMENT', 'mask keyframes are unbounded')
  const sorted = input.keyframes
    .map((entry, index) => Object.freeze({
      frame: entry.frame,
      region: normalizedRegion(entry.region, `keyframes[${index}].region`),
    }))
    .toSorted((left, right) => left.frame - right.frame)
  assertDomain(
    sorted.every((entry) => Number.isSafeInteger(entry.frame) && entry.frame >= input.range.startFrame && entry.frame < input.range.endFrame) &&
      new Set(sorted.map((entry) => entry.frame)).size === sorted.length &&
      sorted[0]?.frame === input.range.startFrame,
    'INVALID_ARGUMENT',
    'mask keyframes must be unique, ordered and begin at the range start',
  )
  assertDomain(
    stableSerialize(sorted[0]!.region) === stableSerialize(input.defaultRegion),
    'INVALID_ARGUMENT',
    'mask region must equal its first keyframe',
  )
  return Object.freeze(sorted)
}

function seal(
  body: Omit<ReviewCleanupMask, 'maskHash'>,
): Readonly<ReviewCleanupMask> {
  return Object.freeze({ ...body, maskHash: calculateCanonicalHash(body) })
}

export function createReviewCleanupMask(input: {
  id: string
  rootId: string
  workspaceId: string
  projectId: string
  annotation: Readonly<ReviewAnnotation>
  brief: Readonly<TransformationBrief>
  sourceArtifactId: string
  sourceArtifactHash: string
  format: Readonly<ReviewCleanupMaskFormat>
  fps: number
  trackingConfidenceBps: number
  createdByClientId: string
  createdAt: Date | string
}): Readonly<ReviewCleanupMask> {
  const brief = assertTransformationBrief(input.brief)
  assertDomain(
    input.annotation.scope === 'region' && Boolean(input.annotation.region),
    'INVALID_ARGUMENT',
    'Advanced visual cleanup requires a regional review annotation',
  )
  assertDomain(input.annotation.status === 'open', 'VERSION_CONFLICT', 'Review annotation is no longer open')
  assertDomain(
    input.annotation.projectVersionId === brief.projectVersionId &&
      input.annotation.proxyArtifactId && input.annotation.proxyHash,
    'VERSION_CONFLICT',
    'Mask annotation and TransformationBrief must target the same immutable project version',
  )
  assertDomain(
    input.sourceArtifactId === brief.sourceArtifactId && input.sourceArtifactHash === brief.sourceArtifactHash,
    'VERSION_CONFLICT',
    'Mask source must match the TransformationBrief source',
  )
  assertDomain(Number.isFinite(input.fps) && input.fps > 0 && input.fps <= 240, 'INVALID_ARGUMENT', 'mask fps is invalid')
  const annotationFrame = input.annotation.frame
  assertDomain(
    annotationFrame >= brief.sourceRange.startFrame && annotationFrame < brief.sourceRange.endFrame,
    'INVALID_ARGUMENT',
    'Review annotation is outside the TransformationBrief range',
  )
  const region = normalizedRegion(input.annotation.region!, 'annotation.region')
  const preserveRegions = Object.freeze(brief.safeZones.map((zone) => Object.freeze({
    purpose: zone.purpose,
    region: normalizedRegion(zone, `safeZone.${zone.purpose}`),
  })))
  assertDomain(
    preserveRegions.every((preserve) => !overlaps(region, preserve.region)),
    'ASSET_RIGHTS_BLOCKED',
    'Cleanup mask overlaps a protected preserve region',
  )
  const rangeStart = Math.max(
    brief.sourceRange.startFrame,
    Math.floor(input.annotation.timeRangeMs[0] * input.fps / 1_000),
  )
  const rangeEnd = Math.min(
    brief.sourceRange.endFrame,
    Math.max(rangeStart + 1, Math.ceil(input.annotation.timeRangeMs[1] * input.fps / 1_000)),
  )
  const range = Object.freeze({ startFrame: rangeStart, endFrame: rangeEnd })
  const keyframes = canonicalKeyframes({
    keyframes: [{ frame: rangeStart, region }],
    range,
    defaultRegion: region,
  })
  return seal({
    schemaVersion: REVIEW_CLEANUP_MASK_SCHEMA_VERSION,
    policyVersion: REVIEW_CLEANUP_MASK_POLICY_VERSION,
    id: identity(input.id, 'id'),
    rootId: identity(input.rootId, 'rootId'),
    revision: 1,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    projectVersionId: brief.projectVersionId,
    annotationId: uuid(input.annotation.id, 'annotationId'),
    annotationHash: calculateReviewAnnotationHash(input.annotation),
    proxyArtifactId: identity(input.annotation.proxyArtifactId, 'proxyArtifactId'),
    proxyHash: hash(input.annotation.proxyHash, 'proxyHash'),
    sourceArtifactId: identity(input.sourceArtifactId, 'sourceArtifactId'),
    sourceArtifactHash: hash(input.sourceArtifactHash, 'sourceArtifactHash'),
    transformationBriefId: brief.id,
    transformationBriefHash: brief.briefHash,
    format: format(input.format),
    range,
    region,
    keyframes,
    preserveRegions,
    tracking: Object.freeze({
      status: 'static' as const,
      confidenceBps: basisPoints(input.trackingConfidenceBps, 'trackingConfidenceBps'),
    }),
    formatChange: null,
    createdByClientId: identity(input.createdByClientId, 'createdByClientId'),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
}

export function refineReviewCleanupMask(input: {
  prior: Readonly<ReviewCleanupMask>
  id: string
  region: Readonly<NormalizedMaskRegion>
  range: Readonly<{ startFrame: number; endFrame: number }>
  keyframes: readonly Readonly<ReviewCleanupMaskKeyframe>[]
  trackingStatus: ReviewCleanupMaskTrackingStatus
  trackingConfidenceBps: number
  format?: Readonly<ReviewCleanupMaskFormat>
  acknowledgeFormatChange?: boolean
  createdByClientId: string
  createdAt: Date | string
}): Readonly<ReviewCleanupMask> {
  assertReviewCleanupMask(input.prior)
  const { maskHash: _priorMaskHash, ...priorBody } = input.prior
  assertDomain(
    Number.isSafeInteger(input.range.startFrame) && Number.isSafeInteger(input.range.endFrame) &&
      input.range.startFrame >= 0 && input.range.endFrame > input.range.startFrame,
    'INVALID_ARGUMENT',
    'refined mask range is invalid',
  )
  assertDomain(
    REVIEW_CLEANUP_MASK_TRACKING_STATUSES.includes(input.trackingStatus),
    'INVALID_ARGUMENT',
    'tracking status is invalid',
  )
  const nextFormat = format(input.format ?? input.prior.format)
  const changedFormat = stableSerialize(nextFormat) !== stableSerialize(input.prior.format)
  assertDomain(
    !changedFormat || input.acknowledgeFormatChange === true,
    'PRECONDITION_REQUIRED',
    'Format changes require explicit mask reprojection acknowledgement',
  )
  assertDomain(
    !changedFormat || input.trackingStatus === 'uncertain',
    'PRECONDITION_REQUIRED',
    'A reprojected mask remains uncertain until reviewed in the target format',
  )
  const region = normalizedRegion(input.region, 'region')
  assertDomain(
    input.prior.preserveRegions.every((preserve) => !overlaps(region, preserve.region)),
    'ASSET_RIGHTS_BLOCKED',
    'Refined cleanup mask overlaps a protected preserve region',
  )
  const range = Object.freeze({ ...input.range })
  const keyframes = canonicalKeyframes({ keyframes: input.keyframes, range, defaultRegion: region })
  return seal({
    ...priorBody,
    id: identity(input.id, 'id'),
    revision: input.prior.revision + 1,
    supersedesId: input.prior.id,
    format: nextFormat,
    range,
    region,
    keyframes,
    tracking: Object.freeze({
      status: input.trackingStatus,
      confidenceBps: basisPoints(input.trackingConfidenceBps, 'trackingConfidenceBps'),
    }),
    formatChange: changedFormat
      ? Object.freeze({
          sourceOutputSpecId: input.prior.format.outputSpecId,
          acknowledged: true,
        })
      : input.prior.formatChange,
    createdByClientId: identity(input.createdByClientId, 'createdByClientId'),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
}

export function assertReviewCleanupMask(
  value: Readonly<ReviewCleanupMask>,
): Readonly<ReviewCleanupMask> {
  assertDomain(
    value.schemaVersion === REVIEW_CLEANUP_MASK_SCHEMA_VERSION &&
      value.policyVersion === REVIEW_CLEANUP_MASK_POLICY_VERSION &&
      Number.isSafeInteger(value.revision) && value.revision >= 1 &&
      HASH.test(value.maskHash),
    'PERSISTENCE_CONFLICT',
    'Stored review cleanup mask metadata is invalid',
  )
  const { maskHash, ...body } = value
  assertDomain(
    calculateCanonicalHash(body) === maskHash,
    'PERSISTENCE_CONFLICT',
    'Stored review cleanup mask hash is invalid',
  )
  try {
    for (const [field, entry] of Object.entries({
      id: value.id, rootId: value.rootId, workspaceId: value.workspaceId,
      projectId: value.projectId, projectVersionId: value.projectVersionId,
      proxyArtifactId: value.proxyArtifactId, sourceArtifactId: value.sourceArtifactId,
      transformationBriefId: value.transformationBriefId, createdByClientId: value.createdByClientId,
    })) identity(entry, field)
    uuid(value.annotationId, 'annotationId')
    for (const [field, entry] of Object.entries({
      annotationHash: value.annotationHash, proxyHash: value.proxyHash,
      sourceArtifactHash: value.sourceArtifactHash,
      transformationBriefHash: value.transformationBriefHash,
    })) hash(entry, field)
    assertDomain(value.revision === 1 ? !value.supersedesId : Boolean(value.supersedesId), 'INVALID_ARGUMENT', 'mask revision lineage is invalid')
    if (value.supersedesId) identity(value.supersedesId, 'supersedesId')
    assertDomain(stableSerialize(format(value.format)) === stableSerialize(value.format), 'INVALID_ARGUMENT', 'mask format is not canonical')
    const canonicalRegion = normalizedRegion(value.region, 'region')
    assertDomain(stableSerialize(canonicalRegion) === stableSerialize(value.region), 'INVALID_ARGUMENT', 'mask region is not canonical')
    assertDomain(Number.isSafeInteger(value.range.startFrame) && Number.isSafeInteger(value.range.endFrame) && value.range.startFrame >= 0 && value.range.endFrame > value.range.startFrame, 'INVALID_ARGUMENT', 'mask range is invalid')
    assertDomain(stableSerialize(canonicalKeyframes({ keyframes: value.keyframes, range: value.range, defaultRegion: canonicalRegion })) === stableSerialize(value.keyframes), 'INVALID_ARGUMENT', 'mask keyframes are not canonical')
    const canonicalPreserves = value.preserveRegions.map((entry) => ({ purpose: entry.purpose, region: normalizedRegion(entry.region, `preserve.${entry.purpose}`) }))
    assertDomain(canonicalPreserves.every((entry) => !overlaps(canonicalRegion, entry.region)) && stableSerialize(canonicalPreserves) === stableSerialize(value.preserveRegions), 'INVALID_ARGUMENT', 'mask preserve regions are invalid')
    assertDomain(REVIEW_CLEANUP_MASK_TRACKING_STATUSES.includes(value.tracking.status), 'INVALID_ARGUMENT', 'mask tracking status is invalid')
    basisPoints(value.tracking.confidenceBps, 'tracking.confidenceBps')
    if (value.formatChange) {
      identity(value.formatChange.sourceOutputSpecId, 'formatChange.sourceOutputSpecId')
      assertDomain(value.formatChange.acknowledged === true, 'INVALID_ARGUMENT', 'mask format change acknowledgement is invalid')
    }
    assertDomain(instant(value.createdAt, 'createdAt') === value.createdAt, 'INVALID_ARGUMENT', 'mask createdAt is not canonical')
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored review cleanup mask invariants are invalid')
  }
  return value
}

export function assertReviewCleanupMaskExecutable(input: {
  mask: Readonly<ReviewCleanupMask>
  brief: Readonly<TransformationBrief>
  outputSpecId: string
  minimumTrackingConfidenceBps?: number
}): Readonly<ReviewCleanupMask> {
  const mask = assertReviewCleanupMask(input.mask)
  const brief = assertTransformationBrief(input.brief)
  const minimum = basisPoints(
    input.minimumTrackingConfidenceBps ?? 7_500,
    'minimumTrackingConfidenceBps',
  )
  assertDomain(
    mask.transformationBriefId === brief.id &&
      mask.transformationBriefHash === brief.briefHash &&
      mask.sourceArtifactId === brief.sourceArtifactId &&
      mask.sourceArtifactHash === brief.sourceArtifactHash,
    'VERSION_CONFLICT',
    'Mask no longer matches its TransformationBrief',
  )
  assertDomain(
    mask.format.outputSpecId === input.outputSpecId,
    'PRECONDITION_REQUIRED',
    'Mask was not reviewed in the requested output format',
  )
  assertDomain(
    mask.tracking.status !== 'uncertain' && mask.tracking.confidenceBps >= minimum,
    'PRECONDITION_REQUIRED',
    'Mask tracking requires review before provider submission',
  )
  assertDomain(
    mask.range.startFrame >= brief.sourceRange.startFrame &&
      mask.range.endFrame <= brief.sourceRange.endFrame,
    'VERSION_CONFLICT',
    'Mask tracking range exceeds the TransformationBrief',
  )
  return mask
}

export function projectReviewCleanupMaskProviderInput(
  mask: Readonly<ReviewCleanupMask>,
): Readonly<Record<string, unknown>> {
  assertReviewCleanupMask(mask)
  return Object.freeze({
    schemaVersion: REVIEW_CLEANUP_MASK_SCHEMA_VERSION,
    maskId: mask.id,
    maskHash: mask.maskHash,
    format: mask.format,
    range: mask.range,
    region: mask.region,
    keyframes: mask.keyframes,
    preserveRegions: mask.preserveRegions,
    tracking: mask.tracking,
  })
}
