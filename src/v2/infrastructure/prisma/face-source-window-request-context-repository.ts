import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  FaceSourceWindowRequestContext, FaceSourceWindowRequestContextRepository,
} from '../../application/ports/face-source-window-request-context.ts'
import { evaluatePerceptionSourceAnalysisRights } from '../../domain/perception-source-rights.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { faceSourceProbeClock } from './face-source-window-repository.ts'
import { editPlanReferencesSource } from './perception-producer-request-context-repository.ts'
import { producerPublishClock } from './producer-publish-fence.ts'

/**
 * Admission of one V9 SOURCE window (W65b). The project is the one asking: it must play the source (its current EditPlan references it),
 * have it attached as its source master, and the source must be an available video whose rights allow analysis for that project's
 * locale. The Version and EditPlan snapshot returned are only the audit context of the request; nothing about the timeline is read.
 */
export class PrismaFaceSourceWindowRequestContextRepository implements FaceSourceWindowRequestContextRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  /** The envelope an operation published, for the operation read; scoped to the project the operation was requested from. */
  async readEnvelopeId(input: { workspaceId: string; projectId: string; operationId: string }) {
    const row = await this.client.v2FaceSourceWindowEnvelope.findFirst({
      where: { workspaceId: input.workspaceId, operationId: input.operationId,
        operation: { is: { projectId: input.projectId } } },
      select: { id: true },
    })
    return row ? Object.freeze(row) : null
  }

  async read(input: { workspaceId: string; projectId: string; sourceArtifactId: string }): Promise<Readonly<FaceSourceWindowRequestContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId, currentVersionId: { not: null } },
      select: { id: true, locale: true, currentVersionId: true },
    })
    if (!project?.currentVersionId) return null
    const [version, attached, artifact, manifest] = await Promise.all([
      this.client.v2ProjectVersion.findFirst({
        where: { id: project.currentVersionId, projectId: input.projectId, workspaceId: input.workspaceId },
        include: { editPlanSnapshot: true },
      }),
      this.client.v2ProjectMediaAsset.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, artifactId: input.sourceArtifactId, role: 'source-master' },
        select: { id: true },
      }),
      this.client.v2MediaArtifact.findFirst({
        where: { id: input.sourceArtifactId, workspaceId: input.workspaceId, status: 'available', mediaType: 'video' },
        include: { currentRightsSnapshot: true },
      }),
      this.client.v2MediaArtifactManifest.findFirst({
        where: { workspaceId: input.workspaceId, artifactId: input.sourceArtifactId }, orderBy: { createdAt: 'asc' }, select: { manifestJson: true },
      }),
    ])
    if (!version || !attached || !artifact || version.editPlanSnapshot.kind !== 'edit-plan' ||
        !editPlanReferencesSource(version.editPlanSnapshot.contentJson, input.sourceArtifactId)) return null
    const clock = faceSourceProbeClock(manifest?.manifestJson)
    if (!clock) return null
    const rights = artifact.currentRightsSnapshot ? hydrateAssetRights(artifact.currentRightsSnapshot) : null
    const checkedAt = await producerPublishClock(this.client)
    if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: input.workspaceId, locale: project.locale ?? 'und' }, checkedAt).outcome !== 'allow') return null
    return Object.freeze({
      projectId: input.projectId,
      projectVersionId: version.id,
      projectVersionHash: version.baseHash,
      sourceArtifactId: input.sourceArtifactId,
      sourceSha256: artifact.sha256,
      editPlanSnapshotId: version.editPlanSnapshotId,
      editPlanSnapshotHash: version.editPlanSnapshot.contentHash,
      sourceFps: clock.fps,
      sourceDurationFrames: clock.durationFrames,
    })
  }
}
