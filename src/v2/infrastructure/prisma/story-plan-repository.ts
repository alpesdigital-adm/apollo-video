import { Prisma, type PrismaClient, type V2StoryPlan } from '../../../../generated/prisma-v2/index.js'
import type { StoryPlanRepository, StoredStoryPlan } from '../../application/ports/story-plan-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createStoryPlan, type StoryPlan } from '../../domain/story-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function hydrate(row: V2StoryPlan): Readonly<StoredStoryPlan> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  let stored: StoryPlan
  try { stored = JSON.parse(row.storyJson) as StoryPlan; if (stableSerialize(stored) !== row.storyJson) throw new Error('non-canonical') } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored StoryPlan JSON is invalid') }
  const plan = createStoryPlan({ ...stored, id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, projectVersionId: row.projectVersionId, createdBy: { type: 'api-client', id: row.createdByClientId }, createdAt: row.createdAt.toISOString() })
  if (row.schemaVersion !== 3 || row.storyHash !== plan.storyHash || row.treatmentPlanId !== plan.treatmentPlanRef?.id || row.treatmentSchemaVersion !== plan.treatmentPlanRef?.schemaVersion || row.treatmentContentHash !== plan.treatmentPlanRef?.contentHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored StoryPlan failed integrity validation')
  return Object.freeze({ plan, requestFingerprint: row.requestFingerprint, idempotencyKey: row.idempotencyKey })
}

function storyCore(plan: Readonly<import('../../domain/story-plan.ts').PersistableStoryPlan>): StoryPlan {
  const { id: _id, workspaceId: _workspace, projectId: _project, projectVersionId: _version, storyHash: _hash, createdBy: _actor, createdAt: _created, ...story } = plan
  return story
}

export class PrismaStoryPlanRepository implements StoryPlanRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }
  async findIdempotent(input: Parameters<StoryPlanRepository['findIdempotent']>[0]) {
    const row = await this.client.v2StoryPlan.findUnique({ where: { workspaceId_projectId_createdByClientId_idempotencyKey: { workspaceId: input.workspaceId, projectId: input.projectId, createdByClientId: input.createdByClientId, idempotencyKey: input.idempotencyKey } } })
    if (!row) return null
    if (hydrateExternalActorAudit(row, row.createdByClientId).contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another actor context')
    return hydrate(row)
  }
  async persist(value: Readonly<StoredStoryPlan>, audit: Parameters<StoryPlanRepository['persist']>[1]) {
    const plan = value.plan
    const exactVersion = await this.client.v2ProjectVersion.findFirst({ where: { id: plan.projectVersionId, projectId: plan.projectId, project: { workspaceId: plan.workspaceId } }, select: { id: true } })
    if (!exactVersion) throw new DomainError('PROJECT_NOT_FOUND', 'Exact ProjectVersion for StoryPlan was not found')
    try {
      const row = await this.client.v2StoryPlan.create({ data: { id: plan.id, workspaceId: plan.workspaceId, projectId: plan.projectId, projectVersionId: plan.projectVersionId, schemaVersion: plan.schemaVersion, treatmentPlanId: plan.treatmentPlanRef!.id, treatmentSchemaVersion: plan.treatmentPlanRef!.schemaVersion, treatmentContentHash: plan.treatmentPlanRef!.contentHash, storyJson: stableSerialize(storyCore(plan)), storyHash: plan.storyHash, requestFingerprint: value.requestFingerprint, idempotencyKey: value.idempotencyKey, createdByClientId: plan.createdBy.id, ...externalActorAuditData(audit, plan.workspaceId, plan.createdBy.id), createdAt: new Date(plan.createdAt) } })
      return Object.freeze({ value: hydrate(row), replayed: false })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({ workspaceId: plan.workspaceId, projectId: plan.projectId, createdByClientId: plan.createdBy.id, actorContextHash: audit.contextHash, idempotencyKey: value.idempotencyKey })
        if (replay && replay.requestFingerprint === value.requestFingerprint) return Object.freeze({ value: replay, replayed: true })
      }
      throw error
    }
  }
  async read(input: Parameters<StoryPlanRepository['read']>[0]) { const row = await this.client.v2StoryPlan.findFirst({ where: { id: input.storyPlanId, workspaceId: input.workspaceId, projectId: input.projectId } }); return row ? hydrate(row) : null }
}
