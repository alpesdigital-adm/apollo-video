import { Prisma, type PrismaClient, type V2MontageAlternativeRun } from '../../../../generated/prisma-v2/index.js'

import type { MontageAlternativeRepository, MontageAlternativeRun, PersistedMontageAlternativeRun } from '../../application/ports/montage-alternative-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { hydrateMontageSelection, type MontageSelection } from '../../domain/montage-candidate.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parseCanonical<T>(value: string, field: string): Readonly<T> {
  try {
    const parsed = JSON.parse(value) as T
    if (stableSerialize(parsed) !== value) throw new Error('not canonical')
    return Object.freeze(parsed)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `stored ${field} is invalid`)
  }
}

function hydrate(row: V2MontageAlternativeRun): Readonly<PersistedMontageAlternativeRun> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  const run = parseCanonical<MontageAlternativeRun>(row.runJson, `montage run ${row.id}`)
  const selection = hydrateMontageSelection(parseCanonical<MontageSelection>(row.selectionJson, `montage selection ${row.id}`))
  const { runHash: _ignored, ...runBody } = run
  if (
    calculateCanonicalHash(runBody) !== run.runHash || run.selection.selectionHash !== selection.selectionHash ||
    run.id !== row.id || run.workspaceId !== row.workspaceId || run.projectId !== row.projectId ||
    run.schemaVersion !== row.schemaVersion || run.policyVersion !== row.policyVersion ||
    run.storyPlanRef.id !== row.storyPlanId || run.storyPlanRef.hash !== row.storyPlanHash ||
    run.selection.status !== row.status || run.selection.winnerId !== row.winnerId || run.selection.reason !== row.reason ||
    run.selection.diversity.candidateCount !== row.candidateCount || run.selection.diversity.eligibleCount !== row.eligibleCount ||
    run.selection.diversity.normalized.overall !== Number(row.diversityOverall) || run.selection.selectionHash !== row.selectionHash ||
    run.runHash !== row.runHash || run.createdByClientId !== row.createdByClientId || run.createdAt !== row.createdAt.toISOString()
  ) throw new DomainError('PERSISTENCE_CONFLICT', `stored montage run ${row.id} failed integrity validation`)
  return Object.freeze({ ...run, selection, requestFingerprint: row.requestFingerprint, idempotencyKey: row.idempotencyKey })
}

function data(input: Parameters<MontageAlternativeRepository['create']>[0]) {
  const { run } = input
  return {
    id: run.id, workspaceId: run.workspaceId, projectId: run.projectId, schemaVersion: run.schemaVersion,
    policyVersion: run.policyVersion, storyPlanId: run.storyPlanRef.id, storyPlanHash: run.storyPlanRef.hash,
    status: run.selection.status, winnerId: run.selection.winnerId, reason: run.selection.reason,
    candidateCount: run.selection.diversity.candidateCount, eligibleCount: run.selection.diversity.eligibleCount,
    diversityOverall: new Prisma.Decimal(run.selection.diversity.normalized.overall), selectionJson: stableSerialize(run.selection),
    selectionHash: run.selection.selectionHash, runJson: stableSerialize(run), runHash: run.runHash,
    requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey, createdByClientId: run.createdByClientId,
    ...externalActorAuditData(input.authenticationAudit, run.workspaceId, run.createdByClientId), createdAt: new Date(run.createdAt),
  }
}

export class PrismaMontageAlternativeRepository implements MontageAlternativeRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async readStoryPlanReference(input: { workspaceId: string; projectId: string; storyPlanId: string }) {
    const row = await this.client.v2StoryPlan.findFirst({ where: { id: input.storyPlanId, workspaceId: input.workspaceId, projectId: input.projectId }, select: { id: true, storyHash: true } })
    return row ? Object.freeze({ id: row.id, hash: row.storyHash }) : null
  }

  async findReplay(input: { workspaceId: string; projectId: string; actorClientId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2MontageAlternativeRun.findFirst({ where: { workspaceId: input.workspaceId, projectId: input.projectId, createdByClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!row) return null
    if (row.actorContextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'montage alternative replay belongs to a different authentication context')
    return hydrate(row)
  }

  async create(input: Parameters<MontageAlternativeRepository['create']>[0]) {
    try {
      return await this.client.$transaction(async (tx) => {
        const project = await tx.v2Project.findUnique({ where: { id_workspaceId: { id: input.run.projectId, workspaceId: input.run.workspaceId } }, select: { id: true } })
        if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'project was not found')
        const row = await tx.v2MontageAlternativeRun.create({ data: data(input) })
        return Object.freeze({ run: hydrate(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const replay = await this.findReplay({ workspaceId: input.run.workspaceId, projectId: input.run.projectId, actorClientId: input.run.createdByClientId, idempotencyKey: input.idempotencyKey, actorContextHash: input.authenticationAudit.contextHash })
      if (!replay || replay.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different montage alternative request')
      return Object.freeze({ run: replay, replayed: true })
    }
  }

  async read(input: { workspaceId: string; projectId: string; runId: string }) {
    const row = await this.client.v2MontageAlternativeRun.findFirst({ where: { id: input.runId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? hydrate(row) : null
  }
}
