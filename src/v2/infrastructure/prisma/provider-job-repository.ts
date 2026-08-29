import {
  Prisma,
  type PrismaClient,
  type V2ProviderJob,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ClaimedProviderJob,
  PersistedProviderJob,
  ProviderJobRepository,
} from '../../application/ports/provider-job-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertProviderJob,
  TERMINAL_PROVIDER_JOB_STATUSES,
  type ProviderJob,
} from '../../domain/provider-job.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parseJob(row: V2ProviderJob): Readonly<PersistedProviderJob> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  let job: ProviderJob
  try {
    job = JSON.parse(row.jobJson) as ProviderJob
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored provider job ${row.id} is invalid JSON`)
  }
  assertProviderJob(job)
  if (
    stableSerialize(job) !== row.jobJson || job.id !== row.id ||
    job.workspaceId !== row.workspaceId || job.projectId !== row.projectId ||
    job.originProjectVersionId !== row.originProjectVersionId || job.operation !== row.operation ||
    job.adapterId !== row.adapterId || job.adapterVersion !== row.adapterVersion ||
    job.providerJobId !== (row.providerJobId ?? undefined) || job.inputHash !== row.inputHash ||
    stableSerialize(job.input) !== row.inputJson || job.authorization.authorizationHash !== row.authorizationHash ||
    stableSerialize(job.authorization) !== row.authorizationJson || job.estimateHash !== (row.estimateHash ?? undefined) ||
    (job.estimate ? stableSerialize(job.estimate) : undefined) !== (row.estimateJson ?? undefined) ||
    job.status !== row.status || job.providerStatus !== (row.providerStatus ?? undefined) ||
    job.attempt !== row.attempt || job.resultArtifact?.artifactId !== (row.resultArtifactId ?? undefined) ||
    job.resultArtifact?.artifactSha256 !== (row.resultArtifactSha256 ?? undefined) ||
    job.criticResultHash !== (row.criticResultHash ?? undefined) || job.jobHash !== row.jobHash ||
    job.idempotencyKey !== row.idempotencyKey || job.createdAt !== row.createdAt.toISOString() ||
    job.updatedAt !== row.updatedAt.toISOString()
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored provider job ${row.id} failed integrity validation`)
  }
  return Object.freeze({ job: Object.freeze(job), requestFingerprint: row.requestFingerprint })
}

function projection(job: Readonly<ProviderJob>) {
  return {
    providerJobId: job.providerJobId ?? null,
    estimateJson: job.estimate ? stableSerialize(job.estimate) : null,
    estimateHash: job.estimateHash ?? null,
    status: job.status,
    providerStatus: job.providerStatus ?? null,
    attempt: job.attempt,
    resultArtifactId: job.resultArtifact?.artifactId ?? null,
    resultArtifactSha256: job.resultArtifact?.artifactSha256 ?? null,
    criticResultHash: job.criticResultHash ?? null,
    normalizedErrorJson: job.normalizedError ? stableSerialize(job.normalizedError) : null,
    jobJson: stableSerialize(job),
    jobHash: job.jobHash,
    submittedAt: job.submittedAt ? new Date(job.submittedAt) : null,
    heartbeatAt: job.heartbeatAt ? new Date(job.heartbeatAt) : null,
    completedAt: job.completedAt ? new Date(job.completedAt) : null,
    updatedAt: new Date(job.updatedAt),
  }
}

async function assertAuthority(
  transaction: Prisma.TransactionClient,
  job: Readonly<ProviderJob>,
  at: Date,
): Promise<void> {
  const [project, profile, artifacts] = await Promise.all([
    transaction.v2Project.findFirst({
      where: { id: job.projectId, workspaceId: job.workspaceId, currentVersionId: job.originProjectVersionId },
      select: { id: true },
    }),
    transaction.v2SyntheticPresenterProfile.findFirst({
      where: {
        workspaceId: job.workspaceId,
        profileHash: job.authorization.profileSnapshotHash,
        status: 'active',
        OR: [
          { id: job.authorization.profileSnapshotId },
          { profileId: job.authorization.profileSnapshotId },
        ],
      },
      select: { id: true },
    }),
    transaction.v2MediaArtifact.findMany({
      where: {
        workspaceId: job.workspaceId,
        id: { in: job.authorization.artifactDecisions.map((entry) => entry.artifactId) },
        status: 'available',
      },
      include: { currentRightsSnapshot: { select: { id: true, snapshotHash: true } } },
    }),
  ])
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const authorized = job.authorization.artifactDecisions.every((decision) => {
    const artifact = byId.get(decision.artifactId)
    return artifact?.currentRightsSnapshotId === decision.rightsSnapshotId &&
      artifact.currentRightsSnapshot?.snapshotHash === decision.rightsSnapshotHash &&
      Date.parse(decision.validUntil) > at.getTime()
  })
  if (!project || !profile || !authorized || Date.parse(job.authorization.expiresAt) <= at.getTime()) {
    throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Provider job authority changed before persistence or submit')
  }
}

export class PrismaProviderJobRepository implements ProviderJobRepository {
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient = getV2PostgresClient()) {
    this.prisma = prisma
  }

  async findReplay(input: Parameters<ProviderJobRepository['findReplay']>[0]) {
    const row = await this.prisma.v2ProviderJob.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        actorContextHash: input.actorContextHash,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row ? parseJob(row) : null
  }

  async create(input: Parameters<ProviderJobRepository['create']>[0]) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await assertAuthority(transaction, input.job, new Date(input.job.createdAt))
        const actor = await transaction.v2ApiClient.findFirst({
          where: { id: input.authenticationAudit.clientId, workspaceId: input.job.workspaceId, status: 'active' },
          select: { id: true },
        })
        if (!actor) throw new DomainError('AUTH_INVALID', 'Provider job actor changed before commit')
        const row = await transaction.v2ProviderJob.create({
          data: {
            id: input.job.id,
            workspaceId: input.job.workspaceId,
            projectId: input.job.projectId,
            originProjectVersionId: input.job.originProjectVersionId,
            schemaVersion: input.job.schemaVersion,
            operation: input.job.operation,
            adapterId: input.job.adapterId,
            adapterVersion: input.job.adapterVersion,
            inputJson: stableSerialize(input.job.input),
            inputHash: input.job.inputHash,
            authorizationJson: stableSerialize(input.job.authorization),
            authorizationHash: input.job.authorization.authorizationHash,
            ...projection(input.job),
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.job.idempotencyKey,
            createdByClientId: input.authenticationAudit.clientId,
            ...externalActorAuditData(input.authenticationAudit, input.job.workspaceId, input.authenticationAudit.clientId),
            createdAt: new Date(input.job.createdAt),
            transitions: {
              create: {
                id: input.transitionId,
                sequence: 1,
                toStatus: input.job.status,
                jobHash: input.job.jobHash,
                occurredAt: new Date(input.job.createdAt),
              },
            },
          },
        })
        return Object.freeze({ persisted: parseJob(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const replay = await this.findReplay({
        workspaceId: input.job.workspaceId,
        actorClientId: input.authenticationAudit.clientId,
        actorContextHash: input.authenticationAudit.contextHash,
        idempotencyKey: input.job.idempotencyKey,
      })
      if (!replay || replay.requestFingerprint !== input.requestFingerprint) {
        throw new DomainError('VERSION_CONFLICT', 'Provider job identity or idempotency key already exists')
      }
      return Object.freeze({ persisted: replay, replayed: true })
    }
  }

  async read(input: Parameters<ProviderJobRepository['read']>[0]) {
    const row = await this.prisma.v2ProviderJob.findFirst({ where: { id: input.jobId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? parseJob(row) : null
  }

  async claimNext(input: Parameters<ProviderJobRepository['claimNext']>[0]) {
    if (input.leaseExpiresAt.getTime() <= input.now.getTime()) throw new DomainError('INVALID_ARGUMENT', 'Provider lease must expire in the future')
    return this.prisma.$transaction(async (transaction) => {
      const row = await transaction.v2ProviderJob.findFirst({
        where: {
          status: { notIn: [...TERMINAL_PROVIDER_JOB_STATUSES] },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: input.now } }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      if (!row) return null
      const claimed = await transaction.v2ProviderJob.updateMany({
        where: {
          id: row.id,
          jobHash: row.jobHash,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: input.now } }],
        },
        data: { leaseOwner: input.workerId, leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt },
      })
      if (claimed.count !== 1) return null
      return Object.freeze({
        ...parseJob(row),
        lease: Object.freeze({ owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() }),
      }) as Readonly<ClaimedProviderJob>
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async advance(input: Parameters<ProviderJobRepository['advance']>[0]) {
    return this.prisma.$transaction(async (transaction) => {
      const row = await transaction.v2ProviderJob.findUnique({ where: { id: input.current.job.id } })
      if (!row || row.jobHash !== input.current.job.jobHash || row.status !== input.current.job.status ||
        row.leaseToken !== input.current.lease.token || row.leaseOwner !== input.current.lease.owner ||
        !row.leaseExpiresAt || row.leaseExpiresAt.getTime() < input.occurredAt.getTime()) {
        throw new DomainError('VERSION_CONFLICT', 'Provider job lease or version was lost')
      }
      if (input.next.status === 'submitted') await assertAuthority(transaction, input.next, input.occurredAt)
      if (input.next.resultArtifact) {
        const artifact = await transaction.v2MediaArtifact.findFirst({
          where: { id: input.next.resultArtifact.artifactId, workspaceId: input.next.workspaceId, sha256: input.next.resultArtifact.artifactSha256, status: 'available' },
          select: { id: true },
        })
        if (!artifact) throw new DomainError('PERSISTENCE_CONFLICT', 'Provider result was not locally ingested before evaluation')
      }
      const sequence = await transaction.v2ProviderJobTransition.count({ where: { jobId: row.id } }) + 1
      const updated = await transaction.v2ProviderJob.update({
        where: { id: row.id },
        data: { ...projection(input.next), leaseOwner: null, leaseToken: null, leaseExpiresAt: null },
      })
      await transaction.v2ProviderJobTransition.create({
        data: {
          id: input.transitionId,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          jobId: row.id,
          sequence,
          fromStatus: row.status,
          toStatus: input.next.status,
          jobHash: input.next.jobHash,
          leaseToken: input.current.lease.token,
          occurredAt: input.occurredAt,
        },
      })
      return parseJob(updated)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async beginSubmission(input: Parameters<ProviderJobRepository['beginSubmission']>[0]) {
    if (input.current.job.status !== 'estimated' || input.next.status !== 'submitting') {
      throw new DomainError('VERSION_CONFLICT', 'Provider submission intent has invalid states')
    }
    return this.prisma.$transaction(async (transaction) => {
      const row = await transaction.v2ProviderJob.findUnique({ where: { id: input.current.job.id } })
      if (!row || row.jobHash !== input.current.job.jobHash || row.status !== input.current.job.status ||
        row.leaseToken !== input.current.lease.token || row.leaseOwner !== input.current.lease.owner ||
        !row.leaseExpiresAt || row.leaseExpiresAt.getTime() < input.occurredAt.getTime()) {
        throw new DomainError('VERSION_CONFLICT', 'Provider job lease or version was lost before submission')
      }
      await assertAuthority(transaction, input.next, input.occurredAt)
      const sequence = await transaction.v2ProviderJobTransition.count({ where: { jobId: row.id } }) + 1
      const updated = await transaction.v2ProviderJob.update({
        where: { id: row.id },
        data: projection(input.next),
      })
      await transaction.v2ProviderJobTransition.create({
        data: {
          id: input.transitionId,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          jobId: row.id,
          sequence,
          fromStatus: row.status,
          toStatus: input.next.status,
          jobHash: input.next.jobHash,
          leaseToken: input.current.lease.token,
          occurredAt: input.occurredAt,
        },
      })
      return Object.freeze({
        ...parseJob(updated),
        lease: input.current.lease,
      }) as Readonly<ClaimedProviderJob>
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }
}
