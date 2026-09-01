import type { PersistedReviewCleanupMask } from '../application/ports/review-cleanup-mask-repository.ts'
import { assertDomain } from '../domain/errors.ts'
import { REVIEW_CLEANUP_MASK_TRACKING_STATUSES, type NormalizedMaskRegion } from '../domain/review-cleanup-mask.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}
function string(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim().length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}
function integer(value: unknown, field: string): number {
  assertDomain(Number.isSafeInteger(value), 'INVALID_ARGUMENT', `${field} must be an integer`)
  return Number(value)
}
function region(value: unknown, field: string): Readonly<NormalizedMaskRegion> {
  const item = record(value, field)
  const keys = ['x', 'y', 'width', 'height']
  assertDomain(Object.keys(item).every((key) => keys.includes(key)) && keys.every((key) => key in item), 'INVALID_ARGUMENT', `${field} contains missing or unsupported properties`)
  return Object.freeze({ x: Number(item.x), y: Number(item.y), width: Number(item.width), height: Number(item.height) })
}
function format(value: unknown) {
  const item = record(value, 'body.format')
  const keys = ['outputSpecId', 'width', 'height']
  assertDomain(Object.keys(item).every((key) => keys.includes(key)) && keys.every((key) => key in item), 'INVALID_ARGUMENT', 'body.format contains missing or unsupported properties')
  return Object.freeze({ outputSpecId: string(item.outputSpecId, 'body.format.outputSpecId'), width: integer(item.width, 'body.format.width'), height: integer(item.height, 'body.format.height') })
}

export function parseCreateReviewCleanupMaskBody(raw: unknown) {
  const body = record(raw, 'body')
  const keys = ['annotationId', 'transformationBriefId', 'format', 'trackingConfidenceBps']
  assertDomain(Object.keys(body).every((key) => keys.includes(key)) && keys.every((key) => key in body), 'INVALID_ARGUMENT', 'body contains missing or unsupported properties')
  return Object.freeze({
    annotationId: string(body.annotationId, 'body.annotationId'),
    transformationBriefId: string(body.transformationBriefId, 'body.transformationBriefId'),
    format: format(body.format),
    trackingConfidenceBps: integer(body.trackingConfidenceBps, 'body.trackingConfidenceBps'),
  })
}

export function parseRefineReviewCleanupMaskBody(raw: unknown) {
  const body = record(raw, 'body')
  const required = ['expectedMaskHash', 'region', 'range', 'keyframes', 'trackingStatus', 'trackingConfidenceBps']
  const keys = [...required, 'format', 'acknowledgeFormatChange']
  assertDomain(Object.keys(body).every((key) => keys.includes(key)) && required.every((key) => key in body), 'INVALID_ARGUMENT', 'body contains missing or unsupported properties')
  const rangeValue = record(body.range, 'body.range')
  assertDomain(Object.keys(rangeValue).every((key) => ['startFrame', 'endFrame'].includes(key)) && 'startFrame' in rangeValue && 'endFrame' in rangeValue, 'INVALID_ARGUMENT', 'body.range contains missing or unsupported properties')
  assertDomain(Array.isArray(body.keyframes) && body.keyframes.length > 0, 'INVALID_ARGUMENT', 'body.keyframes must be a non-empty array')
  const trackingStatus = string(body.trackingStatus, 'body.trackingStatus')
  assertDomain(REVIEW_CLEANUP_MASK_TRACKING_STATUSES.includes(trackingStatus as never), 'INVALID_ARGUMENT', 'body.trackingStatus is unsupported')
  if (body.acknowledgeFormatChange !== undefined) assertDomain(typeof body.acknowledgeFormatChange === 'boolean', 'INVALID_ARGUMENT', 'body.acknowledgeFormatChange must be boolean')
  return Object.freeze({
    expectedMaskHash: string(body.expectedMaskHash, 'body.expectedMaskHash'),
    region: region(body.region, 'body.region'),
    range: Object.freeze({ startFrame: integer(rangeValue.startFrame, 'body.range.startFrame'), endFrame: integer(rangeValue.endFrame, 'body.range.endFrame') }),
    keyframes: Object.freeze(body.keyframes.map((value, index) => {
      const item = record(value, `body.keyframes[${index}]`)
      assertDomain(Object.keys(item).every((key) => ['frame', 'region'].includes(key)) && 'frame' in item && 'region' in item, 'INVALID_ARGUMENT', `body.keyframes[${index}] contains missing or unsupported properties`)
      return Object.freeze({ frame: integer(item.frame, `body.keyframes[${index}].frame`), region: region(item.region, `body.keyframes[${index}].region`) })
    })),
    trackingStatus: trackingStatus as (typeof REVIEW_CLEANUP_MASK_TRACKING_STATUSES)[number],
    trackingConfidenceBps: integer(body.trackingConfidenceBps, 'body.trackingConfidenceBps'),
    ...(body.format !== undefined ? { format: format(body.format) } : {}),
    ...(body.acknowledgeFormatChange !== undefined ? { acknowledgeFormatChange: body.acknowledgeFormatChange } : {}),
  })
}

export function presentReviewCleanupMask(persisted: Readonly<PersistedReviewCleanupMask>) {
  const { mask } = persisted
  return Object.freeze({
    id: mask.id, rootId: mask.rootId, revision: mask.revision, supersedesId: mask.supersedesId,
    projectVersionId: mask.projectVersionId,
    annotation: Object.freeze({ id: mask.annotationId, hash: mask.annotationHash }),
    proxy: Object.freeze({ artifactId: mask.proxyArtifactId, hash: mask.proxyHash }),
    source: Object.freeze({ artifactId: mask.sourceArtifactId, hash: mask.sourceArtifactHash }),
    transformationBrief: Object.freeze({ id: mask.transformationBriefId, hash: mask.transformationBriefHash }),
    format: mask.format, range: mask.range, region: mask.region, keyframes: mask.keyframes,
    preserveRegions: mask.preserveRegions, tracking: mask.tracking, formatChange: mask.formatChange,
    maskHash: mask.maskHash, createdByClientId: mask.createdByClientId, createdAt: mask.createdAt,
  })
}
