import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  PerceptionProducerRequestContextRepository,
} from '../../application/ports/perception-producer-request-context.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'

export function editPlanReferencesSource(contentJson: string, sourceArtifactId: string): boolean {
  let plan: unknown
  try { plan = JSON.parse(contentJson) } catch { return false }
  if (!plan || typeof plan !== 'object' || !Array.isArray((plan as Record<string, unknown>).videoTracks)) return false
  return ((plan as Record<string, unknown>).videoTracks as unknown[]).some((track) =>
    !!track && typeof track === 'object' && Array.isArray((track as Record<string, unknown>).clips) &&
    ((track as Record<string, unknown>).clips as unknown[]).some((clip) =>
      !!clip && typeof clip === 'object' &&
      (clip as Record<string, unknown>).sourceArtifactId === sourceArtifactId))
}

export class PrismaPerceptionProducerRequestContextRepository implements PerceptionProducerRequestContextRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  async readEnvelopeId(input: { workspaceId: string; projectId: string; operationId: string }) {
    const row = await this.client.v2PerceptionProducerEnvelope.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId,
        operationId: input.operationId },
      select: { id: true, projectVersionId: true },
    })
    return row ? Object.freeze(row) : null
  }

  async read(input: { workspaceId: string; projectId: string; projectVersionId: string; sourceArtifactId: string }) {
    const [project, version, attached, artifact] = await Promise.all([
      this.client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId,
          currentVersionId: input.projectVersionId },
        select: { id: true, locale: true },
      }),
      this.client.v2ProjectVersion.findFirst({
        where: { id: input.projectVersionId, projectId: input.projectId,
          workspaceId: input.workspaceId },
        include: { editPlanSnapshot: true },
      }),
      this.client.v2ProjectMediaAsset.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId,
          artifactId: input.sourceArtifactId, role: 'source-master' },
        select: { id: true },
      }),
      this.client.v2MediaArtifact.findFirst({
        where: { id: input.sourceArtifactId, workspaceId: input.workspaceId,
          status: 'available', mediaType: 'video' },
        include: { currentRightsSnapshot: true },
      }),
    ])
    if (!project || !version || !attached || !artifact ||
        version.editPlanSnapshot.kind !== 'edit-plan' ||
        !editPlanReferencesSource(version.editPlanSnapshot.contentJson, input.sourceArtifactId)) return null
    const rights = artifact.currentRightsSnapshot
      ? hydrateAssetRights(artifact.currentRightsSnapshot) : null
    if (evaluateAssetUse(rights, { workspaceId: input.workspaceId,
      use: 'editorial-reuse', locale: project.locale ?? 'und' }, new Date()).outcome !== 'allow') return null
    return Object.freeze({
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      projectVersionHash: version.baseHash,
      sourceArtifactId: input.sourceArtifactId,
      sourceSha256: artifact.sha256,
      editPlanSnapshotId: version.editPlanSnapshotId,
      editPlanSnapshotHash: version.editPlanSnapshot.contentHash,
    })
  }
}
