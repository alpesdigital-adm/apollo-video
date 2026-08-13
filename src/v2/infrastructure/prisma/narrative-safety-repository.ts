import type { PrismaClient, V2StoryPlan } from '../../../../generated/prisma-v2/index.js'
import type { NarrativeSafetyRepository } from '../../application/ports/narrative-safety-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createNarrativeSafetyContext, type NarrativeStatement } from '../../domain/narrative-safety.ts'
import { createStoryPlan, type PersistableStoryPlan } from '../../domain/story-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

export class PrismaNarrativeSafetyRepository implements NarrativeSafetyRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }
  async load(input: Parameters<NarrativeSafetyRepository['load']>[0]) {
    const [version, row] = await Promise.all([
      this.client.v2ProjectVersion.findFirst({ where: { id: input.projectVersionId, projectId: input.projectId, workspaceId: input.workspaceId, storySnapshotId: { not: null } }, include: { storySnapshot: true } }),
      this.client.v2StoryPlan.findFirst({ where: { id: input.storyPlanId, projectId: input.projectId, workspaceId: input.workspaceId, projectVersionId: input.projectVersionId } }),
    ])
    if (!version?.storySnapshot || !row) return null
    const storyPlan = hydrateStoryPlan(row)
    let stored: { schemaVersion: string; storyPlan: PersistableStoryPlan; narrativeSafety: { schemaVersion: string; storyPlanId: string; contextHash: string; statements: readonly NarrativeStatement[] } }
    try { stored = JSON.parse(version.storySnapshot.contentJson) as typeof stored; if (stableSerialize(stored) !== version.storySnapshot.contentJson || calculateCanonicalHash(stored) !== version.storySnapshot.contentHash) throw new Error('integrity') } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored narrative safety snapshot failed integrity validation') }
    if (version.storySnapshot.kind !== 'story' || version.storySnapshot.schemaVersion !== 1 || stored.schemaVersion !== 'narrative-safety-story-snapshot/v1' || stored.storyPlan?.id !== input.storyPlanId || stored.storyPlan.storyHash !== storyPlan.storyHash || stableSerialize(stored.storyPlan) !== stableSerialize(storyPlan) || stored.narrativeSafety?.schemaVersion !== 'narrative-safety-context/v1' || stored.narrativeSafety.storyPlanId !== input.storyPlanId || !Array.isArray(stored.narrativeSafety.statements)) throw new DomainError('PERSISTENCE_CONFLICT', 'Narrative safety snapshot does not match the exact persisted StoryPlan')
    const context = createNarrativeSafetyContext({ storyPlanId: input.storyPlanId, storyPlan, statements: stored.narrativeSafety.statements })
    if (context.contextHash !== stored.narrativeSafety.contextHash || context.statements.some((statement, index) => statement.statementHash !== stored.narrativeSafety.statements[index]?.statementHash)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored narrative safety context failed canonical integrity validation')
    return Object.freeze({ projectVersionId: version.id, projectVersionBaseHash: version.baseHash, storyPlanId: input.storyPlanId, storySnapshotHash: version.storySnapshot.contentHash, storyPlan, context })
  }
}

function hydrateStoryPlan(row: V2StoryPlan): Readonly<PersistableStoryPlan> {
  let core: Omit<PersistableStoryPlan, 'id' | 'workspaceId' | 'projectId' | 'projectVersionId' | 'storyHash' | 'createdBy' | 'createdAt'>
  try { core = JSON.parse(row.storyJson) as typeof core; if (stableSerialize(core) !== row.storyJson) throw new Error('canonical') } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored StoryPlan JSON failed canonical validation') }
  const { schemaVersion: _schemaVersion, ...input } = core
  const plan = createStoryPlan({ ...input, id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, projectVersionId: row.projectVersionId, createdBy: { type: 'api-client', id: row.createdByClientId }, createdAt: row.createdAt.toISOString() })
  if (row.schemaVersion !== 3 || row.storyHash !== plan.storyHash || row.treatmentPlanId !== plan.treatmentPlanRef?.id || row.treatmentSchemaVersion !== plan.treatmentPlanRef?.schemaVersion || row.treatmentContentHash !== plan.treatmentPlanRef?.contentHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored StoryPlan failed integrity validation')
  return plan
}
