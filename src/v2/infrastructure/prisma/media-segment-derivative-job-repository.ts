import type { PrismaClient, V2MediaSegmentDerivativeJob } from '../../../../generated/prisma-v2/index.js'
import type { MediaSegmentDerivativeJob, MediaSegmentDerivativeJobRepository, MediaSegmentDerivativeJobStatus } from '../../application/ports/media-segment-derivative-job-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import type { PreparedSegmentDerivative } from '../../application/ports/media-segment-derivative-job-repository.ts'
import { PrismaMediaArtifactRepository } from './media-artifact-repository.ts'
import { PrismaMediaSegmentRepository } from './media-segment-repository.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { mediaLibraryRights } from '../../domain/media-library.ts'

function mapped(row: V2MediaSegmentDerivativeJob): Readonly<MediaSegmentDerivativeJob> {
  const statuses = ['queued', 'running', 'retrying', 'succeeded', 'failed', 'canceled']
  if (!statuses.includes(row.status)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored segment derivative job status is invalid')
  return Object.freeze({ id: row.id, workspaceId: row.workspaceId, segmentId: row.segmentId, consumerKey: row.consumerKey, sourceSha256: row.sourceSha256, segmentHash: row.segmentHash, rightsSnapshotId: row.rightsSnapshotId, clientId: row.clientId, actorContextHash: row.actorContextHash, idempotencyKey: row.idempotencyKey, requestFingerprint: row.requestFingerprint, status: row.status as MediaSegmentDerivativeJobStatus, attempt: row.attempt, maxAttempts: row.maxAttempts, deadlineAt: row.deadlineAt.toISOString(), ...(row.outputArtifactId ? { outputArtifactId: row.outputArtifactId } : {}), ...(row.outputManifestId ? { outputManifestId: row.outputManifestId } : {}), ...(row.errorCode ? { errorCode: row.errorCode } : {}), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })
}

export class PrismaMediaSegmentDerivativeJobRepository implements MediaSegmentDerivativeJobRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }

  async publish(jobId: string, owner: string, attempt: number, prepare: () => Promise<PreparedSegmentDerivative>, signal?: AbortSignal) {
    return this.client.$transaction(async (tx) => {
      // Cancellation, lease recovery and publication serialize on the same row.
      await tx.$queryRaw`SELECT "id" FROM "media_segment_derivative_jobs" WHERE "id" = ${jobId} FOR UPDATE`
      const job = await tx.v2MediaSegmentDerivativeJob.findUnique({ where: { id: jobId } })
      const assertLease = () => {
        const now = new Date()
        if (signal?.aborted || !job || job.status !== 'running' || job.leaseOwner !== owner || job.attempt !== attempt || !job.leaseExpiresAt || job.leaseExpiresAt <= now || job.deadlineAt <= now) throw new DomainError('PERSISTENCE_CONFLICT', 'Derivative publication requires its current unexpired lease')
      }
      assertLease()
      const segment = await tx.v2MediaSegment.findFirst({ where: { workspaceId: job!.workspaceId, id: job!.segmentId } })
      if (!segment) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Derivative segment is unavailable')
      await tx.$queryRaw`SELECT "id" FROM "media_artifacts" WHERE "id" = ${segment.artifactId} AND "workspaceId" = ${job!.workspaceId} FOR UPDATE`
      const artifact = await tx.v2MediaArtifact.findUnique({ where: { id: segment.artifactId }, include: { currentRightsSnapshot: true } })
      if (!artifact || artifact.status !== 'available' || artifact.sha256 !== job!.sourceSha256 || artifact.currentRightsSnapshotId !== job!.rightsSnapshotId || segment.segmentHash !== job!.segmentHash) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Derivative source or rights changed before publication')
      const assertRights = () => {
        if (mediaLibraryRights(artifact.currentRightsSnapshot ? hydrateAssetRights(artifact.currentRightsSnapshot) : null, { workspaceId: job!.workspaceId, locale: 'pt-BR', now: new Date() }).status !== 'eligible') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Derivative rights expired before publication')
      }
      // Promotion cannot start after an accepted cancel/reclaim/expired deadline.
      assertLease()
      assertRights()
      const prepared = await prepare()
      assertLease()
      assertRights()
      if (prepared.bundle.workspaceId !== job!.workspaceId || prepared.materialization.workspaceId !== job!.workspaceId || prepared.materialization.segmentId !== job!.segmentId || prepared.materialization.consumerKey !== job!.consumerKey || prepared.materialization.sourceArtifactSha256 !== job!.sourceSha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Derivative publication does not match its leased request')
      const persisted = await new PrismaMediaArtifactRepository(this.client).persistOrReplay(prepared.bundle, tx)
      const record = await new PrismaMediaSegmentRepository(this.client).recordMaterialization({ ...prepared.materialization, outputArtifactId: persisted.artifactId, outputManifestId: persisted.manifestId }, tx)
      assertLease()
      assertRights()
      await tx.v2MediaSegmentDerivativeJob.update({ where: { id: jobId }, data: { status: 'succeeded', outputArtifactId: record.outputArtifactId, outputManifestId: record.outputManifestId, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() } })
      return record
    }, { timeout: 10_000, maxWait: 5_000 })
  }

  async enqueue(input: Omit<MediaSegmentDerivativeJob, 'status' | 'attempt' | 'maxAttempts' | 'updatedAt'>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.client.$transaction(async (tx) => {
          const sameKey = await tx.v2MediaSegmentDerivativeJob.findUnique({ where: { workspaceId_clientId_idempotencyKey: { workspaceId: input.workspaceId, clientId: input.clientId, idempotencyKey: input.idempotencyKey } } })
          if (sameKey) {
            if (sameKey.requestFingerprint !== input.requestFingerprint || sameKey.actorContextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another segment derivative request')
            return Object.freeze({ job: mapped(sameKey), replayed: true })
          }
          const sameDerivative = await tx.v2MediaSegmentDerivativeJob.findUnique({ where: { workspaceId_segmentId_consumerKey: { workspaceId: input.workspaceId, segmentId: input.segmentId, consumerKey: input.consumerKey } } })
          if (sameDerivative) {
            if (sameDerivative.sourceSha256 !== input.sourceSha256 || sameDerivative.segmentHash !== input.segmentHash || sameDerivative.rightsSnapshotId !== input.rightsSnapshotId) throw new DomainError('PERSISTENCE_CONFLICT', 'Segment derivative input changed')
            return Object.freeze({ job: mapped(sameDerivative), replayed: true })
          }
          const segment = await tx.v2MediaSegment.findFirst({ where: { id: input.segmentId, workspaceId: input.workspaceId }, include: { artifact: { select: { sha256: true, currentRightsSnapshotId: true, status: true, mediaType: true } } } })
          if (!segment || segment.segmentHash !== input.segmentHash || segment.artifact.sha256 !== input.sourceSha256 || segment.artifact.currentRightsSnapshotId !== input.rightsSnapshotId || segment.artifact.status !== 'available' || segment.artifact.mediaType !== 'video') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Segment source or rights changed before derivative job creation')
          const created = await tx.v2MediaSegmentDerivativeJob.create({ data: { ...input, status: 'queued', attempt: 0, maxAttempts: 3, createdAt: new Date(input.createdAt), updatedAt: new Date(input.createdAt), deadlineAt: new Date(input.deadlineAt) } })
          return Object.freeze({ job: mapped(created), replayed: false })
        }, { isolationLevel: 'Serializable' })
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (attempt < 2 && (code === 'P2002' || code === 'P2034')) continue
        throw error
      }
    }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Derivative job could not be serialized')
  }

  async read(workspaceId: string, jobId: string) {
    const row = await this.client.v2MediaSegmentDerivativeJob.findFirst({ where: { workspaceId, id: jobId } })
    return row ? mapped(row) : null
  }

  async cancel(workspaceId: string, jobId: string, actorContextHash: string, now: Date) {
    const row = await this.client.v2MediaSegmentDerivativeJob.findFirst({ where: { workspaceId, id: jobId, actorContextHash } })
    if (!row) return null
    if (row.status === 'queued' || row.status === 'retrying' || row.status === 'running') await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { id: jobId, workspaceId, status: row.status }, data: { status: 'canceled', leaseOwner: null, leaseExpiresAt: null, updatedAt: now } })
    return this.read(workspaceId, jobId)
  }

  async retry(workspaceId: string, jobId: string, actorContextHash: string, now: Date) {
    const row = await this.client.v2MediaSegmentDerivativeJob.findFirst({ where: { workspaceId, id: jobId, actorContextHash } })
    if (!row) return null
    if (row.status !== 'failed' || row.attempt >= row.maxAttempts) throw new DomainError('INVALID_ARGUMENT', 'Derivative job cannot be retried')
    await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { id: jobId, workspaceId, status: 'failed', attempt: row.attempt }, data: { status: 'retrying', errorCode: null, nextAttemptAt: now, deadlineAt: new Date(now.getTime() + 10 * 60_000), updatedAt: now } })
    return this.read(workspaceId, jobId)
  }

  async claim(owner: string, now: Date, leaseUntil: Date) {
    await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { status: { in: ['queued', 'retrying', 'running'] }, deadlineAt: { lte: now } }, data: { status: 'failed', errorCode: 'RENDER_DEADLINE_EXCEEDED', leaseOwner: null, leaseExpiresAt: null, updatedAt: now } })
    await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { status: 'running', leaseExpiresAt: { lte: now }, attempt: { gte: 3 } }, data: { status: 'failed', errorCode: 'RENDER_RETRY_EXHAUSTED', leaseOwner: null, leaseExpiresAt: null, updatedAt: now } })
    for (let n = 0; n < 3; n += 1) {
      const row = await this.client.v2MediaSegmentDerivativeJob.findFirst({ where: { deadlineAt: { gt: now }, attempt: { lt: 3 }, OR: [{ status: { in: ['queued', 'retrying'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, { status: 'running', leaseExpiresAt: { lte: now } }] }, orderBy: { createdAt: 'asc' } })
      if (!row) return null
      const updated = await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { id: row.id, status: row.status, attempt: row.attempt, deadlineAt: { gt: now }, ...(row.status === 'running' ? { leaseExpiresAt: { lte: now } } : {}) }, data: { status: 'running', attempt: { increment: 1 }, leaseOwner: owner, leaseExpiresAt: leaseUntil, heartbeatAt: now, nextAttemptAt: null, updatedAt: now } })
      if (updated.count === 1) return this.read(row.workspaceId, row.id)
    }
    return null
  }

  async heartbeat(jobId: string, owner: string, attempt: number, now: Date, leaseUntil: Date) {
    const updated = await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { id: jobId, status: 'running', leaseOwner: owner, attempt, leaseExpiresAt: { gt: now }, deadlineAt: { gt: now } }, data: { heartbeatAt: now, leaseExpiresAt: leaseUntil, updatedAt: now } })
    return updated.count === 1
  }

  async failOrRetry(jobId: string, owner: string, attempt: number, errorCode: string, retryable: boolean, now: Date) {
    const status = retryable && attempt < 3 ? 'retrying' : 'failed'
    const updated = await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { id: jobId, status: 'running', leaseOwner: owner, attempt }, data: { status, errorCode, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: status === 'retrying' ? new Date(now.getTime() + Math.min(300_000, 5_000 * 2 ** (attempt - 1))) : null, updatedAt: now } })
    return updated.count === 1
  }
}
