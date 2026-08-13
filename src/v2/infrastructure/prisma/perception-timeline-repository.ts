import { Prisma, type PrismaClient, type V2PerceptionTimeline } from '../../../../generated/prisma-v2/index.js'

import { calculatePerceptionTimelineRecordHash } from '../../application/perception-timelines.ts'
import type { PerceptionTimelineRepository, PersistedPerceptionTimeline } from '../../application/ports/perception-timeline-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createPerceptionTimeline, type PerceptionCoverage, type PerceptionObservation } from '../../domain/perception-timeline.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function isPrismaCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function hydrate(row: V2PerceptionTimeline): Readonly<PersistedPerceptionTimeline> {
  let parsed: { observations?: unknown; coverage?: unknown }
  try { parsed = JSON.parse(row.timelineJson) as typeof parsed } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception timeline JSON is invalid')
  }
  if (!Array.isArray(parsed.observations) || !Array.isArray(parsed.coverage)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception timeline is incomplete')
  }
  const timeline = createPerceptionTimeline({
    durationMs: row.durationMs,
    observations: parsed.observations as PerceptionObservation[],
    coverage: (parsed.coverage as PerceptionCoverage[]).map((entry) => ({
      kind: entry.kind, ranges: entry.ranges,
    })),
  })
  if (timeline.timelineHash !== row.timelineHash || stableSerialize(timeline) !== row.timelineJson) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception timeline failed integrity validation')
  }
  const authenticationAudit = hydrateExternalActorAudit(row, row.createdByClientId)
  const content = Object.freeze({
    schemaVersion: 'persisted-perception-timeline/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    baseRevision: row.baseRevision,
    timeline,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    authenticationAudit,
    createdByClientId: row.createdByClientId,
    createdAt: row.createdAt.toISOString(),
  })
  if (calculatePerceptionTimelineRecordHash(content) !== row.recordHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception timeline record hash is invalid')
  }
  return Object.freeze({ ...content, recordHash: row.recordHash })
}

export class PrismaPerceptionTimelineRepository implements PerceptionTimelineRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  async findIdempotent(input: {
    workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string
  }) {
    const row = await this.client.v2PerceptionTimeline.findUnique({
      where: { workspaceId_projectId_idempotencyKey: {
        workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey,
      } },
    })
    if (!row) return null
    const timeline = hydrate(row)
    if (timeline.authenticationAudit.contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Perception replay belongs to another authentication context')
    }
    return timeline
  }

  async findLatest(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true },
    })
    if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    const row = await this.client.v2PerceptionTimeline.findFirst({
      where: input,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrate(row) : null
  }

  async persist(value: Readonly<PersistedPerceptionTimeline>, attempt = 1): ReturnType<PerceptionTimelineRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2PerceptionTimeline.findUnique({
          where: { workspaceId_projectId_idempotencyKey: {
            workspaceId: value.workspaceId, projectId: value.projectId, idempotencyKey: value.idempotencyKey,
          } },
        })
        if (existing) {
          const current = hydrate(existing)
          if (
            current.requestFingerprint !== value.requestFingerprint ||
            current.authenticationAudit.contextHash !== value.authenticationAudit.contextHash
          ) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another perception timeline')
          return Object.freeze({ timeline: current, replayed: true })
        }
        const latest = await transaction.v2PerceptionTimeline.findFirst({
          where: { workspaceId: value.workspaceId, projectId: value.projectId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { timelineHash: true },
        })
        if ((latest?.timelineHash ?? null) !== value.baseRevision) {
          throw new DomainError('VERSION_CONFLICT', 'Perception timeline baseRevision is stale')
        }
        const [version, actor] = await Promise.all([
          transaction.v2ProjectVersion.findFirst({ where: {
            id: value.projectVersionId, projectId: value.projectId, workspaceId: value.workspaceId,
          }, select: { id: true } }),
          transaction.v2ApiClient.findFirst({ where: {
            id: value.createdByClientId, workspaceId: value.workspaceId, status: 'active',
          }, select: { id: true } }),
        ])
        if (!version || !actor) throw new DomainError('PERSISTENCE_CONFLICT', 'Perception timeline commit context is unavailable')
        const created = await transaction.v2PerceptionTimeline.create({ data: {
          id: value.id,
          workspaceId: value.workspaceId,
          projectId: value.projectId,
          projectVersionId: value.projectVersionId,
          baseRevision: value.baseRevision,
          durationMs: value.timeline.durationMs,
          timelineJson: stableSerialize(value.timeline),
          timelineHash: value.timeline.timelineHash,
          requestFingerprint: value.requestFingerprint,
          idempotencyKey: value.idempotencyKey,
          recordHash: value.recordHash,
          createdByClientId: value.createdByClientId,
          ...externalActorAuditData(value.authenticationAudit, value.workspaceId, value.createdByClientId),
          createdAt: new Date(value.createdAt),
        } })
        return Object.freeze({ timeline: hydrate(created), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if ((isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) && attempt < 3) return this.persist(value, attempt + 1)
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) throw new DomainError('PERSISTENCE_CONFLICT', 'Perception timeline conflicted with another transaction')
      throw error
    }
  }
}
