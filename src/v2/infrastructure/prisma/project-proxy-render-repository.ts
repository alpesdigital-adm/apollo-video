import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { ProjectProxyRenderRepository, ProjectProxyRenderSource } from '../../application/ports/project-proxy-render-repository.ts'
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

function hydrateSource(project: Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>): Readonly<ProjectProxyRenderSource> | null {
  const version = project?.versions[0]
  const media = project?.mediaAssets[0]
  const manifest = media?.artifact.manifests[0]
  if (!project || !version || !media || !manifest) return null
  const editPlan = parseRecord(version.editPlanSnapshot.contentJson, 'project proxy EditPlan') as unknown as EditorialCutEditPlan | DirectedEditPlan
  const manifestBody = parseRecord(manifest.manifestJson, 'project proxy source manifest')
  const artifactBody = manifestBody.artifact
  if (
    editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' || editPlan.projectVersionId !== version.id ||
    typeof artifactBody !== 'object' || artifactBody === null || Array.isArray(artifactBody) ||
    typeof (artifactBody as Record<string, unknown>).artifactKey !== 'string'
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy source is inconsistent')
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
    originalFileName: media.originalFileName,
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
            : {},
          orderBy: { sequence: 'desc' as const },
          take: 1,
          include: { editPlanSnapshot: true },
        },
        mediaAssets: {
          where: { role: 'source-master', ...(input.sourceArtifactId ? { artifactId: input.sourceArtifactId } : {}) },
          orderBy: { createdAt: 'desc' as const },
          take: 1,
          include: {
            artifact: {
              include: {
                manifests: {
                  where: input.sourceManifestId ? { id: input.sourceManifestId } : {},
                  orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
                  take: 1,
                },
              },
            },
          },
        },
      },
    })
  }

  async readCurrentSource(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: {
        id: true, format: true, currentVersionId: true,
        versions: { where: { currentForProjects: { some: { id: input.projectId, workspaceId: input.workspaceId } } }, take: 1, include: { editPlanSnapshot: true } },
        mediaAssets: { where: { role: 'source-master' }, orderBy: { createdAt: 'desc' }, take: 1, include: { artifact: { include: { manifests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } } } } },
      },
    })
    return hydrateSource(project as Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>)
  }

  async readImmutableSource(input: { workspaceId: string; projectId: string; projectVersionId: string; editPlanSnapshotId: string; sourceArtifactId: string; sourceManifestId: string }) {
    return hydrateSource(await this.queryProject(input))
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
