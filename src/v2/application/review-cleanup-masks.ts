import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createReviewCleanupMask,
  refineReviewCleanupMask,
  type NormalizedMaskRegion,
  type ReviewCleanupMaskFormat,
  type ReviewCleanupMaskKeyframe,
  type ReviewCleanupMaskTrackingStatus,
} from '../domain/review-cleanup-mask.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ReviewAnnotationRepository } from './ports/review-annotation-repository.ts'
import type { ReviewCleanupMaskRepository } from './ports/review-cleanup-mask-repository.ts'
import type { TransformationProviderRegistryRepository } from './ports/transformation-provider-registry-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function identity(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function idempotencyKey(value: string): string {
  assertDomain(value.length >= 8 && value.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key must contain 8 to 128 characters')
  return value
}

function common(input: { workspaceId: string; projectId: string; actor: Readonly<AuthenticatedExternalActor> }) {
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  assertDomain(input.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Cleanup mask actor does not belong to workspace')
  return { workspaceId, projectId }
}

export function createReviewCleanupMaskService(dependencies: {
  masks: ReviewCleanupMaskRepository
  annotations: ReviewAnnotationRepository
  registry: TransformationProviderRegistryRepository
  artifacts: MediaArtifactQueryRepository
  clock: () => Date
  createMaskId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    annotationId: string
    transformationBriefId: string
    format: Readonly<ReviewCleanupMaskFormat>
    trackingConfidenceBps: number
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const { workspaceId, projectId } = common(request)
    const audit = materializeActorAuditContext(request.actor)
    const mutationKey = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-review-cleanup-mask-request/v1', workspaceId, projectId,
      annotationId: request.annotationId, transformationBriefId: request.transformationBriefId,
      format: request.format, trackingConfidenceBps: request.trackingConfidenceBps,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.masks.findIdempotent({ workspaceId, projectId, actorClientId: audit.clientId, actorContextHash: audit.contextHash, idempotencyKey: mutationKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Cleanup mask idempotency payload changed')
      return Object.freeze({ persisted: replay, replayed: true })
    }
    const context = await dependencies.annotations.readPreviewContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PRECONDITION_REQUIRED', 'Project has no current review preview')
    assertDomain(!context.stale && context.projectVersionId === context.currentProjectVersionId, 'VERSION_CONFLICT', 'Cleanup mask must use the current review preview')
    const annotations = await dependencies.annotations.list({ workspaceId, projectId, projectVersionId: context.projectVersionId, limit: 500 })
    const annotation = annotations.find((candidate) => candidate.id === identity(request.annotationId, 'annotationId'))
    if (!annotation) throw new DomainError('ASSET_NOT_FOUND', 'Review annotation was not found on the current project version')
    assertDomain(annotation.proxyArtifactId === context.proxyArtifactId && annotation.proxyHash === context.proxyHash, 'VERSION_CONFLICT', 'Review annotation targets a stale proxy')
    const brief = await dependencies.registry.readBrief({ workspaceId, projectId, briefId: identity(request.transformationBriefId, 'transformationBriefId') })
    if (!brief) throw new DomainError('ASSET_NOT_FOUND', 'TransformationBrief was not found')
    const source = await dependencies.artifacts.findById(workspaceId, brief.sourceArtifactId)
    if (!source || source.status !== 'available') throw new DomainError('ASSET_NOT_USABLE', 'Cleanup source artifact is unavailable')
    assertDomain(source.sha256 === brief.sourceArtifactHash, 'VERSION_CONFLICT', 'Cleanup source artifact changed since the brief was written')
    const id = identity(dependencies.createMaskId(), 'createMaskId()')
    const mask = createReviewCleanupMask({
      id, rootId: id, workspaceId, projectId, annotation, brief,
      sourceArtifactId: source.id, sourceArtifactHash: source.sha256,
      format: request.format, fps: context.fps,
      trackingConfidenceBps: request.trackingConfidenceBps,
      createdByClientId: audit.clientId, createdAt: dependencies.clock(),
    })
    const persisted = await dependencies.masks.persist({ mask, authenticationAudit: audit, idempotencyKey: mutationKey, requestFingerprint })
    return Object.freeze({ persisted, replayed: false })
  }
}

export function refineReviewCleanupMaskService(dependencies: {
  masks: ReviewCleanupMaskRepository
  clock: () => Date
  createMaskId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    maskId: string
    expectedMaskHash: string
    region: Readonly<NormalizedMaskRegion>
    range: Readonly<{ startFrame: number; endFrame: number }>
    keyframes: readonly Readonly<ReviewCleanupMaskKeyframe>[]
    trackingStatus: ReviewCleanupMaskTrackingStatus
    trackingConfidenceBps: number
    format?: Readonly<ReviewCleanupMaskFormat>
    acknowledgeFormatChange?: boolean
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const { workspaceId, projectId } = common(request)
    const audit = materializeActorAuditContext(request.actor)
    const mutationKey = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'refine-review-cleanup-mask-request/v1', workspaceId, projectId,
      maskId: request.maskId, expectedMaskHash: request.expectedMaskHash,
      region: request.region, range: request.range, keyframes: request.keyframes,
      trackingStatus: request.trackingStatus, trackingConfidenceBps: request.trackingConfidenceBps,
      format: request.format ?? null, acknowledgeFormatChange: request.acknowledgeFormatChange ?? false,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.masks.findIdempotent({ workspaceId, projectId, actorClientId: audit.clientId, actorContextHash: audit.contextHash, idempotencyKey: mutationKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Cleanup mask refinement idempotency payload changed')
      return Object.freeze({ persisted: replay, replayed: true })
    }
    const prior = await dependencies.masks.read({ workspaceId, projectId, maskId: identity(request.maskId, 'maskId') })
    if (!prior) throw new DomainError('ASSET_NOT_FOUND', 'Review cleanup mask was not found')
    assertDomain(prior.mask.maskHash === request.expectedMaskHash, 'VERSION_CONFLICT', 'Cleanup mask changed before refinement')
    const latest = await dependencies.masks.readLatest({ workspaceId, projectId, rootId: prior.mask.rootId })
    assertDomain(latest?.mask.id === prior.mask.id, 'VERSION_CONFLICT', 'Cleanup mask has a newer revision')
    const mask = refineReviewCleanupMask({
      prior: prior.mask, id: identity(dependencies.createMaskId(), 'createMaskId()'),
      region: request.region, range: request.range, keyframes: request.keyframes,
      trackingStatus: request.trackingStatus, trackingConfidenceBps: request.trackingConfidenceBps,
      ...(request.format ? { format: request.format } : {}),
      acknowledgeFormatChange: request.acknowledgeFormatChange,
      createdByClientId: audit.clientId, createdAt: dependencies.clock(),
    })
    const persisted = await dependencies.masks.persist({ mask, authenticationAudit: audit, idempotencyKey: mutationKey, requestFingerprint })
    return Object.freeze({ persisted, replayed: false })
  }
}

export function listReviewCleanupMasksService(dependencies: { masks: ReviewCleanupMaskRepository }) {
  return async function execute(request: { workspaceId: string; projectId: string; projectVersionId?: string; limit?: number; actor: Readonly<AuthenticatedExternalActor> }) {
    requireScope(request.actor, 'projects:read')
    const { workspaceId, projectId } = common(request)
    const limit = request.limit ?? 100
    assertDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'INVALID_ARGUMENT', 'Cleanup mask list limit is invalid')
    return dependencies.masks.list({ workspaceId, projectId, projectVersionId: request.projectVersionId, limit })
  }
}
