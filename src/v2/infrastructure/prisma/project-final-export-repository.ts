import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ApprovedProjectFinalExportSource,
  ProjectFinalExportAttemptHistory,
  ProjectFinalExportRepository,
} from '../../application/ports/project-final-export-repository.ts'
import { stableSerialize } from '../../application/version-hash.ts'
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
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
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
    proxyReviewId?: string
    proxyReviewHash?: string
    proxyArtifactId?: string
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
        proxyReviews: {
          where: {
            projectVersionId: input.projectVersionId,
            finalAllowed: true,
            status: 'ready-for-final',
            ...(input.proxyReviewId ? { id: input.proxyReviewId } : {}),
            ...(input.proxyReviewHash ? { reviewHash: input.proxyReviewHash } : {}),
            ...(input.proxyArtifactId ? { proxyArtifactId: input.proxyArtifactId } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            reviewHash: true,
            proxyArtifactId: true,
          },
        },
      },
    })
    const version = project?.versions[0]
    const directorRun = project?.directorRuns[0]
    const proxyReview = project?.proxyReviews[0]
    if (!project || !version || !directorRun || !proxyReview) return null
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
      proxyReviewId: proxyReview.id,
      proxyReviewHash: proxyReview.reviewHash,
      proxyArtifactId: proxyReview.proxyArtifactId,
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
    proxyReviewId: string
    proxyReviewHash: string
    proxyArtifactId: string
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

  async recordAttempt(
    input: Parameters<ProjectFinalExportRepository['recordAttempt']>[0],
  ): Promise<void> {
    const startedAt = new Date(input.startedAt)
    const completedAt = new Date(input.completedAt)
    const validValidators = input.validators.length >= 1 &&
      input.validators.length <= 100 &&
      input.validators.every((validator) =>
        /^[A-Z][A-Z0-9_]{2,63}$/.test(validator.code) &&
        validator.message.trim().length >= 1 &&
        validator.message.length <= 500)
    if (
      !Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
      Number.isNaN(startedAt.getTime()) ||
      Number.isNaN(completedAt.getTime()) ||
      completedAt < startedAt ||
      !validValidators ||
      (input.status === 'promoted' && (
        !input.output ||
        input.error !== undefined ||
        !/^[a-f0-9]{64}$/.test(input.output.sha256) ||
        !Number.isSafeInteger(input.output.byteSize) ||
        input.output.byteSize < 1
      )) ||
      (input.status === 'failed' && (
        input.output !== undefined ||
        !input.error ||
        input.error.code.trim().length < 1 ||
        input.error.message.trim().length < 1
      ))
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export attempt is invalid')
    const validatorsJson = stableSerialize(input.validators)
    await this.client.$transaction(async (transaction) => {
      const existing = await transaction.v2ProjectFinalExportAttempt.findUnique({
        where: {
          operationId_attempt: {
            operationId: input.operationId,
            attempt: input.attempt,
          },
        },
      })
      if (existing) {
        const converged =
          existing.workspaceId === input.workspaceId &&
          existing.status === input.status &&
          existing.validatorsJson === validatorsJson &&
          existing.outputArtifactId === (input.output?.artifactId ?? null) &&
          existing.outputManifestId === (input.output?.manifestId ?? null) &&
          existing.outputSha256 === (input.output?.sha256 ?? null) &&
          existing.outputByteSize === (input.output ? BigInt(input.output.byteSize) : null) &&
          existing.errorCode === (input.error?.code ?? null) &&
          existing.errorMessage === (input.error?.message ?? null) &&
          existing.startedAt.getTime() === startedAt.getTime() &&
          existing.completedAt.getTime() === completedAt.getTime()
        if (!converged) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Final export attempt identity did not converge')
        }
        return
      }
      const operation = await transaction.v2ProjectFinalExportOperation.findFirst({
        where: {
          operationId: input.operationId,
          workspaceId: input.workspaceId,
          operation: {
            status: 'running',
            leaseOwner: input.leaseOwner,
            attempt: input.attempt,
            leaseExpiresAt: { gt: completedAt },
          },
        },
        select: { operationId: true },
      })
      if (!operation) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Final export attempt lost its active lease')
      }
      await transaction.v2ProjectFinalExportAttempt.create({
        data: {
          operationId: input.operationId,
          workspaceId: input.workspaceId,
          attempt: input.attempt,
          status: input.status,
          validatorsJson,
          outputArtifactId: input.output?.artifactId,
          outputManifestId: input.output?.manifestId,
          outputSha256: input.output?.sha256,
          outputByteSize: input.output ? BigInt(input.output.byteSize) : undefined,
          errorCode: input.error?.code,
          errorMessage: input.error?.message,
          startedAt,
          completedAt,
        },
      })
    })
  }

  async readAttemptHistory(input: {
    workspaceId: string
    operationId: string
  }): Promise<Readonly<ProjectFinalExportAttemptHistory> | null> {
    const record = await this.client.v2ProjectFinalExportOperation.findFirst({
      where: {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
      },
      select: {
        operationId: true,
        projectId: true,
        projectVersionId: true,
        proxyReviewId: true,
        outputAspectRatio: true,
        outputWidth: true,
        outputHeight: true,
        outputFps: true,
        outputCodec: true,
        outputAudioCodec: true,
        outputContainer: true,
        outputQuality: true,
        attempts: {
          orderBy: { attempt: 'asc' },
          take: 100,
        },
      },
    })
    if (!record) return null
    if (
      !['9:16', '16:9', '4:5', '1:1', '21:9'].includes(record.outputAspectRatio) ||
      record.outputCodec !== 'h264' ||
      record.outputAudioCodec !== 'aac' ||
      record.outputContainer !== 'mp4' ||
      record.outputQuality !== 'final'
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export profile is invalid')
    }
    const attempts = record.attempts.map((attempt) => {
      let validators: ProjectFinalExportAttemptHistory['attempts'][number]['validators']
      try {
        const parsed = JSON.parse(attempt.validatorsJson) as unknown
        if (
          !Array.isArray(parsed) ||
          parsed.length < 1 ||
          parsed.length > 100 ||
          !parsed.every((validator) =>
            typeof validator === 'object' &&
            validator !== null &&
            !Array.isArray(validator) &&
            typeof (validator as Record<string, unknown>).code === 'string' &&
            typeof (validator as Record<string, unknown>).passed === 'boolean' &&
            typeof (validator as Record<string, unknown>).message === 'string')
        ) throw new Error('invalid')
        validators = parsed as ProjectFinalExportAttemptHistory['attempts'][number]['validators']
      } catch {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export validators are invalid')
      }
      const byteSize = attempt.outputByteSize === null ? undefined : Number(attempt.outputByteSize)
      if (byteSize !== undefined && (!Number.isSafeInteger(byteSize) || byteSize < 1)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export byte size is invalid')
      }
      return Object.freeze({
        attempt: attempt.attempt,
        status: attempt.status as 'failed' | 'promoted',
        validators: Object.freeze(validators.map((validator) => Object.freeze({ ...validator }))),
        ...(attempt.outputArtifactId && attempt.outputManifestId && attempt.outputSha256 && byteSize !== undefined
          ? {
              output: Object.freeze({
                artifactId: attempt.outputArtifactId,
                manifestId: attempt.outputManifestId,
                sha256: attempt.outputSha256,
                byteSize,
              }),
            }
          : {}),
        ...(attempt.errorCode && attempt.errorMessage
          ? { error: Object.freeze({ code: attempt.errorCode, message: attempt.errorMessage }) }
          : {}),
        startedAt: attempt.startedAt.toISOString(),
        completedAt: attempt.completedAt.toISOString(),
      })
    })
    return Object.freeze({
      operationId: record.operationId,
      projectId: record.projectId,
      projectVersionId: record.projectVersionId,
      proxyReviewId: record.proxyReviewId,
      outputSpec: Object.freeze({
        aspectRatio: record.outputAspectRatio as ProjectFinalExportAttemptHistory['outputSpec']['aspectRatio'],
        width: record.outputWidth,
        height: record.outputHeight,
        fps: record.outputFps,
        codec: 'h264',
        audioCodec: 'aac',
        container: 'mp4',
        quality: 'final',
      }),
      attempts: Object.freeze(attempts),
    })
  }
}
