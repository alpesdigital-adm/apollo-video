import type { PrismaClient, V2MediaSegmentDerivativeJob } from '../../../../generated/prisma-v2/index.js'
import type { MediaSegmentDerivativeJob, MediaSegmentDerivativeJobRepository, MediaSegmentDerivativeJobStatus } from '../../application/ports/media-segment-derivative-job-repository.ts'
import { DomainError } from '../../domain/errors.ts'

function mapped(row: V2MediaSegmentDerivativeJob): Readonly<MediaSegmentDerivativeJob> {
  const statuses = ['queued', 'running', 'retrying', 'succeeded', 'failed', 'canceled']
  if (!statuses.includes(row.status)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored segment derivative job status is invalid')
  return Object.freeze({ id: row.id, workspaceId: row.workspaceId, segmentId: row.segmentId, consumerKey: row.consumerKey, sourceSha256: row.sourceSha256, segmentHash: row.segmentHash, rightsSnapshotId: row.rightsSnapshotId, clientId: row.clientId, actorContextHash: row.actorContextHash, idempotencyKey: row.idempotencyKey, requestFingerprint: row.requestFingerprint, status: row.status as MediaSegmentDerivativeJobStatus, attempt: row.attempt, maxAttempts: row.maxAttempts, deadlineAt: row.deadlineAt.toISOString(), ...(row.outputArtifactId ? { outputArtifactId: row.outputArtifactId } : {}), ...(row.outputManifestId ? { outputManifestId: row.outputManifestId } : {}), ...(row.errorCode ? { errorCode: row.errorCode } : {}), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })
}

export class PrismaMediaSegmentDerivativeJobRepository implements MediaSegmentDerivativeJobRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }

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

  async succeed(jobId: string, owner: string, attempt: number, outputArtifactId: string, outputManifestId: string, now: Date) {
    const updated = await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { id: jobId, status: 'running', leaseOwner: owner, attempt, leaseExpiresAt: { gt: now }, deadlineAt: { gt: now } }, data: { status: 'succeeded', outputArtifactId, outputManifestId, leaseOwner: null, leaseExpiresAt: null, updatedAt: now } })
    return updated.count === 1
  }

  async failOrRetry(jobId: string, owner: string, attempt: number, errorCode: string, retryable: boolean, now: Date) {
    const status = retryable && attempt < 3 ? 'retrying' : 'failed'
    const updated = await this.client.v2MediaSegmentDerivativeJob.updateMany({ where: { id: jobId, status: 'running', leaseOwner: owner, attempt }, data: { status, errorCode, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: status === 'retrying' ? new Date(now.getTime() + Math.min(300_000, 5_000 * 2 ** (attempt - 1))) : null, updatedAt: now } })
    return updated.count === 1
  }
}
