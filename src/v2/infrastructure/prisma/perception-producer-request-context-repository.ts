import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'

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

/** Admission for the first temporal slice: one source, unit-rate CFR mapping, at most 300 frames. */
export class PrismaTemporalProducerRequestContextRepository implements PerceptionProducerRequestContextRepository {
  private readonly base: PrismaPerceptionProducerRequestContextRepository

  constructor(private readonly client: PrismaClient) {
    this.base = new PrismaPerceptionProducerRequestContextRepository(client)
  }

  async read(input: { workspaceId: string; projectId: string; projectVersionId: string;
    sourceArtifactId: string }) {
    const context = await this.base.read(input)
    if (!context) return null
    const snapshot = await this.client.v2ProjectSnapshot.findFirst({ where: {
      id: context.editPlanSnapshotId, workspaceId: input.workspaceId,
      projectId: input.projectId, kind: 'edit-plan', contentHash: context.editPlanSnapshotHash,
    }, select: { contentJson: true } })
    if (!snapshot) return null
    let plan: Record<string, unknown>
    try { plan = JSON.parse(snapshot.contentJson) as Record<string, unknown> }
    catch { return null }
    if (!plan || calculateCanonicalHash(plan) !== context.editPlanSnapshotHash ||
        !Number.isSafeInteger(plan.fps) || Number(plan.fps) < 1 ||
        !Number.isSafeInteger(plan.durationFrames) || Number(plan.durationFrames) < 2 ||
        Number(plan.durationFrames) > 300 || !Array.isArray(plan.videoTracks)) return null
    const clips = plan.videoTracks.flatMap((track: unknown) => {
      if (!track || typeof track !== 'object' || !Array.isArray((track as Record<string, unknown>).clips)) return []
      return (track as { clips: unknown[] }).clips
    })
    if (!clips.length || clips.length > 300) return null
    let cursor = 0
    for (const raw of clips) {
      if (!raw || typeof raw !== 'object') return null
      const clip = raw as Record<string, unknown>
      const sourceIn = clip.sourceInFrame, sourceOut = clip.sourceOutFrame
      const timelineIn = clip.timelineInFrame, timelineOut = clip.timelineOutFrame
      if (clip.sourceArtifactId !== input.sourceArtifactId || clip.rate !== 1 ||
          ![sourceIn, sourceOut, timelineIn, timelineOut].every((value) => Number.isSafeInteger(value)) ||
          Number(sourceIn) < 0 || Number(sourceOut) > 300 || Number(sourceOut) <= Number(sourceIn) ||
          Number(timelineIn) !== cursor ||
          Number(timelineOut) - Number(timelineIn) !== Number(sourceOut) - Number(sourceIn)) return null
      cursor = Number(timelineOut)
    }
    return cursor === Number(plan.durationFrames) ? context : null
  }

  async readEnvelopeId(input: { workspaceId: string; projectId: string; operationId: string }) {
    const row = await this.client.v2TemporalProducerEnvelope.findFirst({ where: input,
      select: { id: true, projectVersionId: true } })
    return row ? Object.freeze(row) : null
  }
}
