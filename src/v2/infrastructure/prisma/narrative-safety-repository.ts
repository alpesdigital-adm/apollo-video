import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { NarrativeSafetyRepository } from '../../application/ports/narrative-safety-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createNarrativeSafetyContext, type NarrativeStatement } from '../../domain/narrative-safety.ts'
import type { StoryPlan } from '../../domain/story-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

export class PrismaNarrativeSafetyRepository implements NarrativeSafetyRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }
  async load(input: Parameters<NarrativeSafetyRepository['load']>[0]) {
    const version = await this.client.v2ProjectVersion.findFirst({ where: { id: input.projectVersionId, projectId: input.projectId, workspaceId: input.workspaceId, storySnapshotId: { not: null } }, include: { storySnapshot: true } })
    if (!version?.storySnapshot) return null
    let stored: StoryPlan & { id?: string; narrativeSafety?: { schemaVersion: string; storyPlanId: string; contextHash: string; statements: readonly NarrativeStatement[] } }
    try { stored = JSON.parse(version.storySnapshot.contentJson) as typeof stored; if (stableSerialize(stored) !== version.storySnapshot.contentJson || calculateCanonicalHash(stored) !== version.storySnapshot.contentHash) throw new Error('integrity') } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored StoryPlan snapshot failed integrity validation') }
    if (version.storySnapshot.kind !== 'story' || version.storySnapshot.schemaVersion !== 1 || stored.id !== input.storyPlanId || stored.narrativeSafety?.schemaVersion !== 'narrative-safety-context/v1' || stored.narrativeSafety.storyPlanId !== input.storyPlanId || !Array.isArray(stored.narrativeSafety.statements)) throw new DomainError('PERSISTENCE_CONFLICT', 'StoryPlan has no canonical narrative safety context')
    const { id: _id, narrativeSafety, ...storyPlan } = stored
    const context = createNarrativeSafetyContext({ storyPlanId: input.storyPlanId, storyPlan, statements: narrativeSafety.statements })
    if (context.contextHash !== narrativeSafety.contextHash || context.statements.some((statement, index) => statement.statementHash !== narrativeSafety.statements[index]?.statementHash)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored narrative safety context failed canonical integrity validation')
    return Object.freeze({ projectVersionId: version.id, projectVersionBaseHash: version.baseHash, storyPlanId: input.storyPlanId, storySnapshotHash: version.storySnapshot.contentHash, storyPlan, context })
  }
}
