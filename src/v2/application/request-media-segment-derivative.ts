import { randomUUID } from 'node:crypto'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { MediaLibraryRepository } from './ports/media-library-repository.ts'
import type { MediaSegmentRepository } from './ports/media-segment-repository.ts'
import type { MediaSegmentDerivativeJobRepository } from './ports/media-segment-derivative-job-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { materializeSegment } from '../domain/media-segment.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export function requestMediaSegmentDerivativeService(dependencies: { segments: MediaSegmentRepository; library: MediaLibraryRepository; jobs: MediaSegmentDerivativeJobRepository; clock?: () => Date; createId?: () => string }) {
  return async (input: { workspaceId: string; segmentId: string; consumerKey: string; requiresPhysicalDerivative: boolean; idempotencyKey?: string; actor: Readonly<AuthenticatedExternalActor> }) => {
    requireScope(input.actor, 'artifacts:write')
    const workspaceId = input.workspaceId.trim(), segmentId = input.segmentId.trim(), consumerKey = input.consumerKey.trim().toLowerCase()
    if (!ID.test(workspaceId) || !ID.test(segmentId) || typeof input.requiresPhysicalDerivative !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'Segment derivative request is invalid')
    const audit = materializeActorAuditContext(input.actor)
    if (audit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Actor workspace does not match segment')
    const segment = await dependencies.segments.find(workspaceId, segmentId)
    if (!segment) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Segment was not found')
    const recipe = materializeSegment(segment, { key: consumerKey, requiresPhysicalDerivative: input.requiresPhysicalDerivative })
    const item = await dependencies.library.findById(workspaceId, segmentId, dependencies.clock?.() ?? new Date())
    if (!item || item.kind !== 'segment' || item.status !== 'usable' || item.rights.status !== 'eligible' || !item.rights.snapshotId) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Segment is not eligible for reuse')
    if (!recipe) return Object.freeze({ kind: 'virtual' as const, segmentId, parentArtifactId: segment.parentAssetId, segmentHash: segment.segmentHash, semanticRange: segment.semanticRange, sourceTimeMapping: segment.sourceTimeMapping, physicalDerivative: null, bytesDuplicated: false as const })
    const source = await dependencies.segments.readSource(workspaceId, segment.parentAssetId)
    if (!source || source.mediaType !== 'video') throw new DomainError('INVALID_ARGUMENT', 'Physical derivative requires an available video source')
    const existing = await dependencies.segments.findMaterialization(workspaceId, segmentId, consumerKey)
    if (existing) return Object.freeze({ kind: 'ready' as const, segmentId, materialization: existing, replayed: true as const })
    const key = input.idempotencyKey?.trim() ?? ''
    if (!/^[\x21-\x7e]{8,128}$/.test(key)) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is required for a physical derivative')
    const now = dependencies.clock?.() ?? new Date()
    const result = await dependencies.jobs.enqueue({ id: dependencies.createId?.() ?? `segment-job-${randomUUID()}`, workspaceId, segmentId, consumerKey, sourceSha256: source.sha256, segmentHash: segment.segmentHash, rightsSnapshotId: item.rights.snapshotId, clientId: audit.clientId, actorContextHash: audit.contextHash, idempotencyKey: key, requestFingerprint: calculateCanonicalHash({ schemaVersion: 'segment-derivative-request/v1', workspaceId, segmentId, consumerKey, sourceSha256: source.sha256, segmentHash: segment.segmentHash, rightsSnapshotId: item.rights.snapshotId, actorContextHash: audit.contextHash }), deadlineAt: new Date(now.getTime() + 10 * 60_000).toISOString(), createdAt: now.toISOString() })
    return Object.freeze({ kind: 'job' as const, segmentId, job: result.job, replayed: result.replayed })
  }
}
