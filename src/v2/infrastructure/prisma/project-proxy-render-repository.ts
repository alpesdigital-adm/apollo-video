import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { ProjectProxyRenderRepository, ProjectProxyRenderSource } from '../../application/ports/project-proxy-render-repository.ts'
import type { ProxyQualityIssue } from '../../application/render-workflow.ts'
import { DomainError } from '../../domain/errors.ts'

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseCriticIssues(value: string | undefined): readonly Readonly<ProxyQualityIssue>[] {
  if (!value) return Object.freeze([])
  const quality = parseRecord(value, 'project proxy QualityReport')
  if (!Array.isArray(quality.issues)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy QualityReport is invalid')
  return Object.freeze(quality.issues.map((candidate) => {
    if (
      typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) ||
      typeof candidate.code !== 'string' ||
      !['hard', 'warning'].includes(String(candidate.severity)) ||
      !['technical', 'policy', 'integrity', 'editorial'].includes(String(candidate.category)) ||
      typeof candidate.message !== 'string' ||
      typeof candidate.correctable !== 'boolean'
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy QualityReport issue is invalid')
    const range = candidate.rangeMs
    if (
      range !== undefined &&
      (!Array.isArray(range) || range.length !== 2 || range.some((item) => !Number.isSafeInteger(item) || item < 0))
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy QualityReport range is invalid')
    return Object.freeze({
      code: candidate.code,
      severity: candidate.severity as 'hard' | 'warning',
      category: candidate.category as ProxyQualityIssue['category'],
      message: candidate.message,
      ...(range ? { rangeMs: Object.freeze([range[0], range[1]] as [number, number]) } : {}),
      ...(typeof candidate.targetId === 'string' ? { targetId: candidate.targetId } : {}),
      correctable: candidate.correctable,
    })
  }))
}

function hydrateSource(
  project: Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>,
  expected?: { sourceArtifactId?: string; sourceManifestId?: string },
): Readonly<ProjectProxyRenderSource> | null {
  const version = project?.versions[0]
  const media = project?.mediaAssets.find((item) =>
    item.role === 'source-master' &&
    (!expected?.sourceArtifactId || item.artifactId === expected.sourceArtifactId))
  const manifest = expected?.sourceManifestId
    ? media?.artifact.manifests.find((item) => item.id === expected.sourceManifestId)
    : media?.artifact.manifests[0]
  if (!project || !version || !media || !manifest) return null
  const editPlan = parseRecord(version.editPlanSnapshot.contentJson, 'project proxy EditPlan') as unknown as EditorialCutEditPlan | DirectedEditPlan
  const manifestBody = parseRecord(manifest.manifestJson, 'project proxy source manifest')
  const artifactBody = manifestBody.artifact
  if (
    editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' || editPlan.projectVersionId !== version.id ||
    typeof artifactBody !== 'object' || artifactBody === null || Array.isArray(artifactBody) ||
    typeof (artifactBody as Record<string, unknown>).artifactKey !== 'string'
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy source is inconsistent')
  const clips = editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  const referencedArtifactIds = [...new Set(clips.flatMap((clip) => [
    clip.sourceArtifactId,
    clip.audioSourceArtifactId ?? clip.sourceArtifactId,
  ]))].sort()
  const renderSources = referencedArtifactIds.map((artifactId) => {
    const link = project.mediaAssets.find((item) => item.artifactId === artifactId)
    const sourceManifest = link?.artifact.manifests[0]
    const sourceBody = sourceManifest
      ? parseRecord(sourceManifest.manifestJson, `project render source manifest ${sourceManifest.id}`)
      : null
    const sourceArtifact = sourceBody?.artifact
    if (
      !link ||
      !sourceManifest ||
      link.artifact.status !== 'available' ||
      !['video', 'audio'].includes(link.artifact.mediaType) ||
      typeof sourceArtifact !== 'object' ||
      sourceArtifact === null ||
      Array.isArray(sourceArtifact) ||
      typeof (sourceArtifact as Record<string, unknown>).artifactKey !== 'string'
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Referenced render source ${artifactId} is unavailable`,
      )
    }
    return Object.freeze({
      artifactId,
      manifestId: sourceManifest.id,
      artifactKey: (sourceArtifact as Record<string, unknown>).artifactKey as string,
      sha256: link.artifact.sha256,
      byteSize: Number(link.artifact.byteSize),
      mediaType: link.artifact.mediaType as 'video' | 'audio',
      container: link.artifact.container,
      role: link.role === 'source-master'
        ? 'source-master' as const
        : 'selected-insert' as const,
    })
  })
  if (!renderSources.some((item) => item.artifactId === media.artifactId)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Compiled EditPlan no longer references its source master audio or video',
    )
  }
  return Object.freeze({
    projectId: project.id,
    projectVersionId: version.id,
    editPlanSnapshotId: version.editPlanSnapshotId,
    editPlanHash: version.editPlanSnapshot.contentHash,
    editPlan: Object.freeze(editPlan),
    format: project.format ?? '9:16',
    sourceArtifactId: media.artifactId,
    sourceManifestId: manifest.id,
    sourceArtifactKey: (artifactBody as Record<string, unknown>).artifactKey as string,
    sourceSha256: media.artifact.sha256,
    renderSources: Object.freeze(renderSources),
    originalFileName: media.originalFileName,
    uploadReceivedAt: (media.upload?.createdAt ?? media.createdAt).toISOString(),
    criticIssues: parseCriticIssues(version.directorRunAsResult?.qualitySnapshot.contentJson),
  })
}

export class PrismaProjectProxyRenderRepository implements ProjectProxyRenderRepository {
  constructor(private readonly client: PrismaClient) {}

  queryProject(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    editPlanSnapshotId?: string
    sourceArtifactId?: string
    sourceManifestId?: string
  }) {
    return this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: {
        id: true,
        format: true,
        currentVersionId: true,
        versions: {
          where: input.projectVersionId
            ? { id: input.projectVersionId, ...(input.editPlanSnapshotId ? { editPlanSnapshotId: input.editPlanSnapshotId } : {}) }
            : { currentForProjects: { some: { id: input.projectId, workspaceId: input.workspaceId } } },
          orderBy: { sequence: 'desc' as const },
          take: 1,
          include: {
            editPlanSnapshot: true,
            directorRunAsResult: { include: { qualitySnapshot: true } },
          },
        },
        mediaAssets: {
          orderBy: [{ role: 'asc' as const }, { createdAt: 'desc' as const }],
          include: { upload: { select: { createdAt: true } }, artifact: {
            include: {
              manifests: {
                orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
                take: 8,
              },
            },
          } },
        },
      },
    })
  }

  async readCurrentSource(input: { workspaceId: string; projectId: string }) {
    return hydrateSource(await this.queryProject(input))
  }

  async readImmutableSource(input: { workspaceId: string; projectId: string; projectVersionId: string; editPlanSnapshotId: string; sourceArtifactId: string; sourceManifestId: string }) {
    return hydrateSource(await this.queryProject(input), input)
  }

  async attachCompletedOutput(input: Parameters<ProjectProxyRenderRepository['attachCompletedOutput']>[0]): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      const [operation, artifact, manifest] = await Promise.all([
        transaction.v2ProjectProxyRenderOperation.findFirst({ where: {
          operationId: input.operationId, workspaceId: input.workspaceId, projectId: input.projectId,
          projectVersionId: input.projectVersionId, outputArtifactId: input.outputArtifactId, outputManifestId: input.outputManifestId,
        } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.outputArtifactId, workspaceId: input.workspaceId, status: 'available' } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.outputManifestId, workspaceId: input.workspaceId, artifactId: input.outputArtifactId } }),
      ])
      if (!operation || !artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project proxy output is inconsistent')
      await transaction.v2ProjectMediaAsset.upsert({
        where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.outputArtifactId, role: 'editorial-proxy' } },
        create: {
          id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId, artifactId: input.outputArtifactId,
          role: 'editorial-proxy', originalFileName: input.originalFileName, createdAt: new Date(input.createdAt),
        },
        update: {},
      })
      await transaction.v2DirectorRun.updateMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          resultVersionId: input.projectVersionId,
          status: { in: ['planned', 'rendering'] },
        },
        data: { status: 'succeeded' },
      })
    })
  }
}
