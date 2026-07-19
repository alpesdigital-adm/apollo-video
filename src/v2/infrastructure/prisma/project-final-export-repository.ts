import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ApprovedProjectFinalExportSource,
  ProjectFinalExportRepository,
} from '../../application/ports/project-final-export-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { PrismaProjectProxyRenderRepository } from './project-proxy-render-repository.ts'

function parseQuality(value: string): { status: string; score: number } {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    const quality = parsed as Record<string, unknown>
    if (typeof quality.status !== 'string' || typeof quality.score !== 'number' || !Number.isFinite(quality.score)) throw new Error('invalid')
    return { status: quality.status, score: quality.score }
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export QualityReport is invalid')
  }
}

export class PrismaProjectFinalExportRepository implements ProjectFinalExportRepository {
  private readonly sourceReader: PrismaProjectProxyRenderRepository

  constructor(private readonly client: PrismaClient) {
    this.sourceReader = new PrismaProjectProxyRenderRepository(client)
  }

  private async readApproval(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    directorRunId?: string
    qualitySnapshotId?: string
    qualitySnapshotHash?: string
    requireCurrent: boolean
  }) {
    const project = await this.client.v2Project.findFirst({
      where: {
        id: input.projectId,
        workspaceId: input.workspaceId,
        ...(input.requireCurrent ? { currentVersionId: input.projectVersionId } : {}),
      },
      select: {
        locale: true,
        versions: {
          where: { id: input.projectVersionId, baseHash: input.projectVersionHash },
          take: 1,
          select: { id: true },
        },
        directorRuns: {
          where: {
            resultVersionId: input.projectVersionId,
            status: 'succeeded',
            ...(input.directorRunId ? { id: input.directorRunId } : {}),
            ...(input.qualitySnapshotId ? { qualitySnapshotId: input.qualitySnapshotId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { qualitySnapshot: true },
        },
      },
    })
    const version = project?.versions[0]
    const directorRun = project?.directorRuns[0]
    if (!project || !version || !directorRun) return null
    if (input.qualitySnapshotHash && directorRun.qualitySnapshot.contentHash !== input.qualitySnapshotHash) return null
    const quality = parseQuality(directorRun.qualitySnapshot.contentJson)
    if (!['approved', 'approved-with-warnings'].includes(quality.status)) return null
    return Object.freeze({
      locale: project.locale ?? 'pt-BR',
      directorRunId: directorRun.id,
      qualitySnapshotId: directorRun.qualitySnapshotId,
      qualitySnapshotHash: directorRun.qualitySnapshot.contentHash,
      qualityStatus: quality.status as 'approved' | 'approved-with-warnings',
      qualityScore: quality.score,
    })
  }

  async readApprovedCurrentSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null> {
    const [source, approval] = await Promise.all([
      this.sourceReader.readCurrentSource({ workspaceId: input.workspaceId, projectId: input.projectId }),
      this.readApproval({ ...input, requireCurrent: true }),
    ])
    if (!source || !approval || source.projectVersionId !== input.projectVersionId) return null
    return Object.freeze({ ...source, projectVersionHash: input.projectVersionHash, ...approval })
  }

  async readImmutableApprovedSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    editPlanSnapshotId: string
    directorRunId: string
    qualitySnapshotId: string
    qualitySnapshotHash: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null> {
    const [source, approval] = await Promise.all([
      this.sourceReader.readImmutableSource(input),
      this.readApproval({ ...input, requireCurrent: false }),
    ])
    if (!source || !approval) return null
    return Object.freeze({ ...source, projectVersionHash: input.projectVersionHash, ...approval })
  }

  async convergeOutputIdentity(input: Parameters<ProjectFinalExportRepository['convergeOutputIdentity']>[0]): Promise<void> {
    const now = new Date(input.now)
    if (Number.isNaN(now.getTime())) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export convergence time is invalid')
    await this.client.$transaction(async (transaction) => {
      const operation = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          type: 'project-final-export',
          status: 'running',
          targetType: 'media-artifact',
          targetId: input.reservedArtifactId,
          leaseOwner: input.leaseOwner,
          attempt: input.attempt,
          leaseExpiresAt: { gt: now },
        },
        data: { targetId: input.persistedArtifactId, updatedAt: now },
      })
      const context = await transaction.v2ProjectFinalExportOperation.updateMany({
        where: {
          operationId: input.operationId,
          workspaceId: input.workspaceId,
          outputArtifactId: input.reservedArtifactId,
          outputManifestId: input.reservedManifestId,
        },
        data: {
          outputArtifactId: input.persistedArtifactId,
          outputManifestId: input.persistedManifestId,
        },
      })
      if (operation.count !== 1 || context.count !== 1) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Final export output identity did not converge under its active lease')
      }
    })
  }

  async attachCompletedOutput(input: Parameters<ProjectFinalExportRepository['attachCompletedOutput']>[0]): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      const [operation, artifact, manifest] = await Promise.all([
        transaction.v2ProjectFinalExportOperation.findFirst({
          where: {
            operationId: input.operationId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            projectVersionId: input.projectVersionId,
            outputArtifactId: input.outputArtifactId,
            outputManifestId: input.outputManifestId,
          },
        }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.outputArtifactId, workspaceId: input.workspaceId, status: 'available' } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.outputManifestId, workspaceId: input.workspaceId, artifactId: input.outputArtifactId } }),
      ])
      if (!operation || !artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project final export is inconsistent')
      await transaction.v2ProjectMediaAsset.upsert({
        where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.outputArtifactId, role: 'final-output' } },
        create: {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          artifactId: input.outputArtifactId,
          role: 'final-output',
          originalFileName: input.originalFileName,
          createdAt: new Date(input.createdAt),
        },
        update: {},
      })
      const updated = await transaction.v2Project.updateMany({
        where: { id: input.projectId, workspaceId: input.workspaceId, currentVersionId: input.projectVersionId },
        data: { status: 'completed' },
      })
      if (updated.count !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export no longer matches the current project version')
    })
  }

  async markExportFailed(input: Parameters<ProjectFinalExportRepository['markExportFailed']>[0]): Promise<void> {
    const operation = await this.client.v2ProjectFinalExportOperation.findFirst({
      where: { operationId: input.operationId, workspaceId: input.workspaceId, projectId: input.projectId },
      select: { projectVersionId: true },
    })
    if (!operation) return
    await this.client.v2Project.updateMany({
      where: {
        id: input.projectId,
        workspaceId: input.workspaceId,
        currentVersionId: operation.projectVersionId,
        status: 'rendering-final',
      },
      data: { status: 'failed' },
    })
  }
}
