import { Prisma, type PrismaClient, type V2TreatmentPlan } from '../../../../generated/prisma-v2/index.js'

import type { PersistedTreatmentPlan, TreatmentPlanRepository } from '../../application/ports/treatment-plan-repository.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { resolveStrategicObjective } from '../../domain/strategic-objective.ts'
import { validateTreatmentPlan, type TreatmentPlan } from '../../domain/treatment-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function policyEvidence(row: { id: string; kind: string; schemaVersion: number; contentJson: string; contentHash: string }) {
  try {
    const content = JSON.parse(row.contentJson) as unknown
    if (row.kind !== 'policies' || stableSerialize(content) !== row.contentJson || calculateCanonicalHash(content) !== row.contentHash) throw new Error('invalid')
    return Object.freeze({ id: row.id, schemaVersion: row.schemaVersion, contentHash: row.contentHash })
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'TreatmentPlan Policy Snapshot failed integrity validation')
  }
}

function hydrate(row: V2TreatmentPlan): Readonly<PersistedTreatmentPlan> {
  const audit = hydrateExternalActorAudit(row, row.createdByClientId)
  let parsed: TreatmentPlan
  try {
    parsed = JSON.parse(row.treatmentJson) as TreatmentPlan
    if (stableSerialize(parsed) !== row.treatmentJson) throw new Error('non-canonical')
    validateTreatmentPlan(parsed)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored TreatmentPlan is invalid')
  }
  if (
    row.schemaVersion !== parsed.schemaVersion || row.objective !== parsed.objective || row.mode !== parsed.mode ||
    row.rubricId !== parsed.provenance.rubricId || row.rubricVersion !== parsed.provenance.rubricVersion || row.rubricHash !== parsed.provenance.rubricHash ||
    row.policySnapshotId !== parsed.provenance.policySnapshotId || row.policySchemaVersion !== parsed.provenance.policySchemaVersion || row.policySnapshotHash !== parsed.provenance.policySnapshotHash ||
    row.perceptionSummaryId !== parsed.provenance.perceptionSummaryId || row.perceptionSchemaVersion !== parsed.provenance.perceptionSchemaVersion || row.perceptionSummaryHash !== parsed.provenance.perceptionSummaryHash ||
    row.treatmentHash !== calculateCanonicalHash(parsed) || audit.contextHash !== row.actorContextHash
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored TreatmentPlan failed integrity validation')
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    plan: Object.freeze(parsed),
    treatmentHash: row.treatmentHash,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdByClientId: row.createdByClientId,
    createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaTreatmentPlanRepository implements TreatmentPlanRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async loadContext(input: { workspaceId: string; projectId: string; projectVersionId: string; policySnapshotId: string }) {
    const row = await this.client.v2ProjectVersion.findFirst({
      where: { id: input.projectVersionId, workspaceId: input.workspaceId, projectId: input.projectId, policiesSnapshotId: input.policySnapshotId },
      include: { project: { select: { objective: true } }, policiesSnapshot: true },
    })
    if (!row?.project.objective) return null
    return Object.freeze({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      projectVersionId: row.id,
      objective: resolveStrategicObjective(row.project.objective).id,
      policySnapshot: policyEvidence(row.policiesSnapshot),
    })
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; createdByClientId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2TreatmentPlan.findUnique({
      where: { workspaceId_projectId_createdByClientId_idempotencyKey: { workspaceId: input.workspaceId, projectId: input.projectId, createdByClientId: input.createdByClientId, idempotencyKey: input.idempotencyKey } },
    })
    if (!row) return null
    const value = hydrate(row)
    if (row.actorContextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'TreatmentPlan idempotency belongs to another authenticated actor context')
    return value
  }

  async persist(value: Readonly<PersistedTreatmentPlan>, authenticationAudit: Readonly<ApiAccessAuditContext>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const row = await this.client.$transaction(async (transaction) => {
          const [version, actor] = await Promise.all([
            transaction.v2ProjectVersion.findFirst({
              where: { id: value.projectVersionId, workspaceId: value.workspaceId, projectId: value.projectId, policiesSnapshotId: value.plan.provenance.policySnapshotId },
              include: { project: { select: { objective: true } }, policiesSnapshot: true },
            }),
            transaction.v2ApiClient.findFirst({ where: { id: value.createdByClientId, workspaceId: value.workspaceId, status: 'active' }, select: { id: true } }),
          ])
          if (!version?.project.objective || !actor) throw new DomainError('VERSION_CONFLICT', 'TreatmentPlan context changed before commit')
          const policy = policyEvidence(version.policiesSnapshot)
          if (
            resolveStrategicObjective(version.project.objective).id !== value.plan.objective ||
            policy.schemaVersion !== value.plan.provenance.policySchemaVersion ||
            policy.contentHash !== value.plan.provenance.policySnapshotHash
          ) throw new DomainError('VERSION_CONFLICT', 'TreatmentPlan evidence changed before commit')
          return transaction.v2TreatmentPlan.create({ data: {
            id: value.id,
            workspaceId: value.workspaceId,
            projectId: value.projectId,
            projectVersionId: value.projectVersionId,
            policySnapshotId: value.plan.provenance.policySnapshotId,
            schemaVersion: value.plan.schemaVersion,
            objective: value.plan.objective,
            mode: value.plan.mode,
            rubricId: value.plan.provenance.rubricId,
            rubricVersion: value.plan.provenance.rubricVersion,
            rubricHash: value.plan.provenance.rubricHash,
            policySchemaVersion: value.plan.provenance.policySchemaVersion,
            policySnapshotHash: value.plan.provenance.policySnapshotHash,
            perceptionSummaryId: value.plan.provenance.perceptionSummaryId,
            perceptionSchemaVersion: value.plan.provenance.perceptionSchemaVersion,
            perceptionSummaryHash: value.plan.provenance.perceptionSummaryHash,
            treatmentJson: stableSerialize(value.plan),
            treatmentHash: value.treatmentHash,
            requestFingerprint: value.requestFingerprint,
            idempotencyKey: value.idempotencyKey,
            createdByClientId: value.createdByClientId,
            ...externalActorAuditData(authenticationAudit, value.workspaceId, value.createdByClientId),
            createdAt: new Date(value.createdAt),
          } })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        return Object.freeze({ value: hydrate(row), replayed: false })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) continue
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const replay = await this.findIdempotent({ workspaceId: value.workspaceId, projectId: value.projectId, createdByClientId: value.createdByClientId, idempotencyKey: value.idempotencyKey, actorContextHash: authenticationAudit.contextHash })
          if (replay && replay.requestFingerprint === value.requestFingerprint) return Object.freeze({ value: replay, replayed: true })
        }
        throw error
      }
    }
    throw new DomainError('VERSION_CONFLICT', 'TreatmentPlan serialization retry budget exhausted')
  }

  async read(input: { workspaceId: string; projectId: string; treatmentPlanId: string }) {
    const row = await this.client.v2TreatmentPlan.findFirst({ where: { id: input.treatmentPlanId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? hydrate(row) : null
  }
}
