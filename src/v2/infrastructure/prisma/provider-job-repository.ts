import {
  Prisma,
  type PrismaClient,
  type V2ProviderJob,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ClaimedProviderJob,
  PersistedProviderCallbackEvent,
  PersistedProviderJob,
  ProviderJobRepository,
} from '../../application/ports/provider-job-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertProviderCallbackEvent,
  type ProviderCallbackEvent,
  type ProviderCallbackOutcome,
  type ProviderCallbackRejection,
} from '../../domain/provider-job-callback.ts'
import {
  assertProviderJobTransportState,
  type ProviderJobTransportState,
} from '../../domain/provider-job-transport.ts'
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
    job.updatedAt !== row.updatedAt.toISOString() ||
    job.transport !== (row.transport ?? undefined) ||
    job.transformation?.briefId !== (row.transformationBriefId ?? undefined) ||
    job.transformation?.briefHash !== (row.transformationBriefHash ?? undefined) ||
    job.transformation?.selectionId !== (row.transformationSelectionId ?? undefined) ||
    job.transformation?.selectionHash !== (row.transformationSelectionHash ?? undefined) ||
    job.transformation?.providerId !== (row.transformationProviderId ?? undefined) ||
    job.transformation?.capabilityId !== (row.transformationCapabilityId ?? undefined) ||
    job.observedCost?.currency !== (row.observedCostCurrency ?? undefined) ||
    job.observedCost?.costMinorUnits !== (row.observedCostMinorUnits ?? undefined)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored provider job ${row.id} failed integrity validation`)
  }
  return Object.freeze({ job: Object.freeze(job), requestFingerprint: row.requestFingerprint })
}

type TransportStateRow = {
  workspaceId: string; projectId: string; jobId: string; schemaVersion: string
  transport: string; completion: string; retryPolicyJson: string; retryPolicyHash: string
  waitKind: string; nextAttemptAt: Date | null; deadlineAt: Date; transportAttempts: number
  retryAfterMs: number | null; waitStartedAt: Date | null
  cancellation: string; cancellationRequestedAt: Date | null
  resume: string; resumeRequestedAt: Date | null
  mcpSessionId: string | null; mcpSessionClosedAt: Date | null
  revision: number; updatedAt: Date
}

function parseTransportState(row: TransportStateRow): Readonly<ProviderJobTransportState> {
  let retryPolicy: ProviderJobTransportState['retryPolicy']
  try {
    retryPolicy = JSON.parse(row.retryPolicyJson) as ProviderJobTransportState['retryPolicy']
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored transport state for ${row.jobId} has invalid retry policy JSON`)
  }
  if (retryPolicy.policyHash !== row.retryPolicyHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored retry policy for ${row.jobId} does not match its column hash`)
  }
  return assertProviderJobTransportState(Object.freeze({
    schemaVersion: row.schemaVersion as ProviderJobTransportState['schemaVersion'],
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    jobId: row.jobId,
    transport: row.transport as ProviderJobTransportState['transport'],
    completion: row.completion as ProviderJobTransportState['completion'],
    retryPolicy: Object.freeze(retryPolicy),
    waitKind: row.waitKind as ProviderJobTransportState['waitKind'],
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt.toISOString(),
    transportAttempts: row.transportAttempts,
    retryAfterMs: row.retryAfterMs,
    waitStartedAt: row.waitStartedAt?.toISOString() ?? null,
    cancellation: row.cancellation as ProviderJobTransportState['cancellation'],
    cancellationRequestedAt: row.cancellationRequestedAt?.toISOString() ?? null,
    resume: row.resume as ProviderJobTransportState['resume'],
    resumeRequestedAt: row.resumeRequestedAt?.toISOString() ?? null,
    mcpSessionId: row.mcpSessionId,
    mcpSessionClosedAt: row.mcpSessionClosedAt?.toISOString() ?? null,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  }))
}

function transportStateData(state: Readonly<ProviderJobTransportState>) {
  return {
    schemaVersion: state.schemaVersion,
    transport: state.transport,
    completion: state.completion,
    retryPolicyJson: stableSerialize(state.retryPolicy),
    retryPolicyHash: state.retryPolicy.policyHash,
    waitKind: state.waitKind,
    nextAttemptAt: state.nextAttemptAt ? new Date(state.nextAttemptAt) : null,
    deadlineAt: new Date(state.deadlineAt),
    transportAttempts: state.transportAttempts,
    retryAfterMs: state.retryAfterMs,
    waitStartedAt: state.waitStartedAt ? new Date(state.waitStartedAt) : null,
    cancellation: state.cancellation,
    cancellationRequestedAt: state.cancellationRequestedAt ? new Date(state.cancellationRequestedAt) : null,
    resume: state.resume,
    resumeRequestedAt: state.resumeRequestedAt ? new Date(state.resumeRequestedAt) : null,
    mcpSessionId: state.mcpSessionId,
    mcpSessionClosedAt: state.mcpSessionClosedAt ? new Date(state.mcpSessionClosedAt) : null,
    revision: state.revision,
    updatedAt: new Date(state.updatedAt),
  }
}

type CallbackEventRow = {
  workspaceId: string; providerId: string; eventId: string; jobId: string; schemaVersion: string
  providerJobId: string; status: string; outcome: string; rejectionReason: string | null
  retryAfterMs: number | null; payloadSha256: string; eventHash: string
  occurredAt: Date; receivedAt: Date
}

function parseCallbackEvent(row: CallbackEventRow): Readonly<PersistedProviderCallbackEvent> {
  const event = assertProviderCallbackEvent(Object.freeze({
    schemaVersion: row.schemaVersion as ProviderCallbackEvent['schemaVersion'],
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    eventId: row.eventId,
    jobId: row.jobId,
    providerJobId: row.providerJobId,
    status: row.status as ProviderCallbackEvent['status'],
    occurredAt: row.occurredAt.toISOString(),
    retryAfterMs: row.retryAfterMs,
    payloadSha256: row.payloadSha256,
    receivedAt: row.receivedAt.toISOString(),
    eventHash: row.eventHash,
  }))
  return Object.freeze({
    event,
    outcome: row.outcome as ProviderCallbackOutcome,
    ...(row.rejectionReason ? { rejectionReason: row.rejectionReason as ProviderCallbackRejection } : {}),
  })
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
    transport: job.transport ?? null,
    transformationBriefId: job.transformation?.briefId ?? null,
    transformationBriefHash: job.transformation?.briefHash ?? null,
    transformationSelectionId: job.transformation?.selectionId ?? null,
    transformationSelectionHash: job.transformation?.selectionHash ?? null,
    transformationProviderId: job.transformation?.providerId ?? null,
    transformationCapabilityId: job.transformation?.capabilityId ?? null,
    observedCostCurrency: job.observedCost?.currency ?? null,
    observedCostMinorUnits: job.observedCost?.costMinorUnits ?? null,
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
    for (let attempt = 1; ; attempt += 1) {
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
        // Same transaction as the job. A job that declares a transport but has
        // no schedule would never be picked up by the worker; there is no
        // window in which that pair can exist.
        let transportState: Readonly<ProviderJobTransportState> | null = null
        if (input.transportState) {
          if (
            input.transportState.jobId !== input.job.id ||
            input.transportState.workspaceId !== input.job.workspaceId ||
            input.transportState.projectId !== input.job.projectId ||
            input.transportState.transport !== input.job.transport
          ) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Transport state does not belong to its provider job')
          }
          transportState = parseTransportState(await transaction.v2ProviderJobTransportState.create({
            data: {
              workspaceId: input.job.workspaceId,
              projectId: input.job.projectId,
              jobId: input.job.id,
              ...transportStateData(input.transportState),
              createdAt: new Date(input.job.createdAt),
            },
          }))
        }
        return Object.freeze({ persisted: Object.freeze({ ...parseJob(row), transportState }), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      // Serializable write conflicts against a concurrently polling worker
      // are transient: retry the create instead of surfacing them.
      if (isPrismaCode(error, 'P2034') && attempt < 4) continue
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
  }

  async read(input: Parameters<ProviderJobRepository['read']>[0]) {
    const row = await this.prisma.v2ProviderJob.findFirst({
      where: { id: input.jobId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { transportState: true },
    })
    if (!row) return null
    const { transportState, ...jobRow } = row
    return Object.freeze({ ...parseJob(jobRow), transportState: transportState ? parseTransportState(transportState) : null })
  }

  async findByProviderCorrelation(input: Parameters<ProviderJobRepository['findByProviderCorrelation']>[0]) {
    const row = await this.prisma.v2ProviderJob.findFirst({
      where: { workspaceId: input.workspaceId, adapterId: input.adapterId, providerJobId: input.providerJobId },
      include: { transportState: true },
    })
    if (!row) return null
    const { transportState, ...jobRow } = row
    return Object.freeze({ ...parseJob(jobRow), transportState: transportState ? parseTransportState(transportState) : null })
  }

  async readTransportState(input: Parameters<ProviderJobRepository['readTransportState']>[0]) {
    const row = await this.prisma.v2ProviderJobTransportState.findFirst({
      where: { jobId: input.jobId, workspaceId: input.workspaceId, projectId: input.projectId },
    })
    return row ? parseTransportState(row) : null
  }

  async saveTransportState(input: Parameters<ProviderJobRepository['saveTransportState']>[0]) {
    const saved = await this.prisma.v2ProviderJobTransportState.updateMany({
      where: {
        jobId: input.next.jobId,
        workspaceId: input.next.workspaceId,
        revision: input.expectedRevision,
      },
      data: transportStateData(input.next),
    })
    // Compare-and-swap, not last-write-wins: two operators cancelling the same
    // job concurrently must not silently overwrite each other's intent.
    if (saved.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Transport state advanced concurrently')
    return input.next
  }

  async findCallbackEvent(input: Parameters<ProviderJobRepository['findCallbackEvent']>[0]) {
    const row = await this.prisma.v2ProviderCallbackEvent.findFirst({
      where: {
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        eventId: input.eventId,
        outcome: 'accepted',
      },
    })
    return row ? parseCallbackEvent(row).event : null
  }

  async listCallbackEvents(input: Parameters<ProviderJobRepository['listCallbackEvents']>[0]) {
    const rows = await this.prisma.v2ProviderCallbackEvent.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, jobId: input.jobId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    })
    return Object.freeze(rows.map(parseCallbackEvent))
  }

  async recordCallbackEvent(input: Parameters<ProviderJobRepository['recordCallbackEvent']>[0]) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const row = await transaction.v2ProviderCallbackEvent.create({
          data: {
            id: input.id,
            workspaceId: input.event.workspaceId,
            projectId: input.projectId,
            jobId: input.event.jobId,
            schemaVersion: input.event.schemaVersion,
            providerId: input.event.providerId,
            eventId: input.event.eventId,
            providerJobId: input.event.providerJobId,
            status: input.event.status,
            outcome: input.outcome,
            rejectionReason: input.rejectionReason ?? null,
            retryAfterMs: input.event.retryAfterMs,
            payloadSha256: input.event.payloadSha256,
            eventHash: input.event.eventHash,
            occurredAt: new Date(input.event.occurredAt),
            receivedAt: new Date(input.event.receivedAt),
          },
        })
        // The wake and the consumption of the event id commit together. If they
        // did not, a crash between them would leave an event marked consumed
        // whose effect never happened — and the retry would be refused as a
        // duplicate.
        if (input.wake) {
          const woken = await transaction.v2ProviderJobTransportState.updateMany({
            where: {
              jobId: input.wake.next.jobId,
              workspaceId: input.wake.next.workspaceId,
              revision: input.wake.expectedRevision,
            },
            data: transportStateData(input.wake.next),
          })
          if (woken.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Transport state advanced while the callback was being applied')
        }
        return parseCallbackEvent(row)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      // The partial unique index on accepted events is the replay gate. Losing
      // that race means another delivery of the same event id already landed.
      if (isPrismaCode(error, 'P2002')) {
        throw new DomainError('WEBHOOK_REPLAY_DETECTED', 'Provider callback event was already consumed')
      }
      throw error
    }
  }

  async claimNext(input: Parameters<ProviderJobRepository['claimNext']>[0]) {
    if (input.leaseExpiresAt.getTime() <= input.now.getTime()) throw new DomainError('INVALID_ARGUMENT', 'Provider lease must expire in the future')
    return this.prisma.$transaction(async (transaction) => {
      const row = await transaction.v2ProviderJob.findFirst({
        where: {
          status: { notIn: [...TERMINAL_PROVIDER_JOB_STATUSES] },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: input.now } }],
          // A job parked on a backoff, a Retry-After or a callback wait is not
          // due yet. Without this the worker would spin on it, burn its attempt
          // budget and ignore the delay the provider explicitly asked for.
          AND: [{
            OR: [
              { transportState: { is: null } },
              { transportState: { nextAttemptAt: null } },
              { transportState: { nextAttemptAt: { lte: input.now } } },
            ],
          }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { transportState: true },
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
      const { transportState, ...jobRow } = row
      return Object.freeze({
        ...parseJob(jobRow),
        transportState: transportState ? parseTransportState(transportState) : null,
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
      let transportState: Readonly<ProviderJobTransportState> | null = input.current.transportState ?? null
      if (input.transportState) {
        const saved = await transaction.v2ProviderJobTransportState.updateMany({
          where: {
            jobId: row.id,
            workspaceId: row.workspaceId,
            revision: input.transportState.revision - 1,
          },
          data: transportStateData(input.transportState),
        })
        if (saved.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Transport state advanced concurrently')
        transportState = input.transportState
      }
      return Object.freeze({ ...parseJob(updated), transportState })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async beginSubmission(input: Parameters<ProviderJobRepository['beginSubmission']>[0]) {
    if (input.current.job.status !== 'estimated' || input.next.status !== 'submitting') {
      throw new DomainError('VERSION_CONFLICT', 'Provider submission intent has invalid states')
    }
    for (let attempt = 1; ; attempt += 1) {
    try {
    return await this.prisma.$transaction(async (transaction) => {
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
    } catch (error) {
      // Serializable write conflicts against a concurrently settling reader
      // are transient; surfacing them would mark the job failed with an
      // ambiguous-submission error even though nothing was submitted yet.
      // The in-transaction lease/status/hash guard revalidates on retry.
      if (isPrismaCode(error, 'P2034') && attempt < 4) continue
      throw error
    }
    }
  }
}
