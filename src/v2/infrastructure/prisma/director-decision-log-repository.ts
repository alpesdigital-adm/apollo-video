import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { DirectorDecisionLogRepository } from '../../application/ports/director-decision-log-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { parseDirectorDecisionLog } from '../../domain/director-decision.ts'
import { DomainError } from '../../domain/errors.ts'
import type { StoryPlan } from '../../domain/story-plan.ts'
import { validateStoryPlan } from '../../domain/story-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { PrismaRenderElementMapRepository } from './render-element-map-repository.ts'

function parseLog(row: { decisionLogJson: string | null; decisionLogHash: string | null; workspaceId: string; projectId: string; id: string; commandId: string; resultVersionId: string }) {
  if (!row.decisionLogJson || !row.decisionLogHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Director run has no immutable decision log')
  let value: unknown
  try { value = JSON.parse(row.decisionLogJson) } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log JSON is invalid') }
  const log = parseDirectorDecisionLog(value)
  if (stableSerialize(log) !== row.decisionLogJson || log.logHash !== row.decisionLogHash || log.workspaceId !== row.workspaceId || log.projectId !== row.projectId || log.runId !== row.id || log.commandId !== row.commandId || log.resultVersionId !== row.resultVersionId) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log binding is invalid')
  return log
}

export class PrismaDirectorDecisionLogRepository implements DirectorDecisionLogRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }

  async loadLog(input: { workspaceId: string; projectId: string; directorRunId: string }) {
    const row = await this.client.v2DirectorRun.findFirst({ where: { id: input.directorRunId, workspaceId: input.workspaceId, projectId: input.projectId }, select: { id: true, workspaceId: true, projectId: true, commandId: true, resultVersionId: true, decisionLogJson: true, decisionLogHash: true } })
    return row ? parseLog(row) : null
  }

  async loadLineage(input: { workspaceId: string; projectId: string; directorRunId: string; decisionId: string }) {
    const run = await this.client.v2DirectorRun.findFirst({ where: { id: input.directorRunId, workspaceId: input.workspaceId, projectId: input.projectId }, include: { storySnapshot: true } })
    if (!run) return null
    const log = parseLog(run)
    const decision = log.entries.find((entry) => entry.id === input.decisionId)
    if (!decision) return null
    let storedStory: StoryPlan & { id?: string }
    try { storedStory = JSON.parse(run.storySnapshot.contentJson) as StoryPlan & { id?: string } } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored StoryPlan JSON is invalid') }
    if (stableSerialize(storedStory) !== run.storySnapshot.contentJson || calculateCanonicalHash(storedStory) !== run.storySnapshot.contentHash || storedStory.id === undefined) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored StoryPlan integrity is invalid')
    validateStoryPlan(storedStory)
    const blocks = decision.planNodeIds.map((nodeId) => storedStory.blocks.find((item) => item.id === nodeId))
    if (blocks.some((block) => !block)) throw new DomainError('PERSISTENCE_CONFLICT', 'Decision references a missing StoryPlan node')
    const finalExport = await this.client.v2ProjectFinalExportOperation.findFirst({ where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: log.resultVersionId, directorRunId: log.runId, operation: { status: 'succeeded', phase: 'completed' } }, orderBy: [{ createdAt: 'desc' }, { operationId: 'desc' }], select: { outputArtifactId: true, proxyArtifactId: true, projectVersionId: true } })
    if (!finalExport) return Object.freeze({ status: 'unavailable' as const, reason: 'FINAL_ARTIFACT_NOT_READY' as const })
    const artifact = await this.client.v2MediaArtifact.findFirst({ where: { id: finalExport.outputArtifactId, workspaceId: input.workspaceId, status: 'available' }, select: { id: true } })
    if (!artifact) return Object.freeze({ status: 'unavailable' as const, reason: 'FINAL_ARTIFACT_NOT_READY' as const })
    const elementMap = await new PrismaRenderElementMapRepository(this.client).findExact({ workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: finalExport.projectVersionId, proxyArtifactId: finalExport.proxyArtifactId })
    if (!elementMap) return Object.freeze({ status: 'unavailable' as const, reason: 'RENDER_ELEMENT_MAP_NOT_READY' as const })
    const planNodeSourceIds = [...new Set(blocks.flatMap((block) => block!.sourceCandidateIds))]
    const frameMap = elementMap.map.elements.filter((element) => planNodeSourceIds.includes(element.clipId)).map((element) => Object.freeze({ clipId: element.clipId, frame: element.frame }))
    if (frameMap.length === 0) return Object.freeze({ status: 'unavailable' as const, reason: 'PLAN_NODE_NOT_RENDERED' as const })
    return Object.freeze({ status: 'ready' as const, artifactId: artifact.id, projectVersionId: finalExport.projectVersionId, fps: elementMap.map.fps, planNodeSourceIds: Object.freeze(planNodeSourceIds), frameMap: Object.freeze(frameMap) })
  }
}
