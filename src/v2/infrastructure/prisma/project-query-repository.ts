import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import type { ProjectQueryRepository } from '../../application/ports/project-query-repository.ts'
import {
  createProjectDashboardRecord,
  type ProjectDashboardRecord,
} from '../../domain/project-dashboard.ts'
import { createProject, type ProjectStatus } from '../../domain/project.ts'
import type {
  PublicOperationPhase,
  PublicOperationStatus,
  PublicOperationType,
} from '../../domain/public-operation.ts'
import type { OutputAspectRatio } from '../../domain/output-spec.ts'
import type { CommandActorType } from '../../domain/edit-command.ts'

export class PrismaProjectQueryRepository implements ProjectQueryRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async listByWorkspace(input: {
    workspaceId: string
    limit: number
    after?: { createdAt: string; id: string }
    filters?: {
      text?: string; status?: string; objective?: string; format?: string; locale?: string
      createdFrom?: string; createdTo?: string; ownerId?: string
    }
  }): Promise<readonly ProjectDashboardRecord[]> {
    const filters = input.filters
    const rows = await this.client.v2Project.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(filters?.text
          ? { name: { contains: filters.text, mode: 'insensitive' as const } }
          : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.objective ? { objective: filters.objective } : {}),
        ...(filters?.format ? { format: filters.format } : {}),
        ...(filters?.locale ? { locale: filters.locale } : {}),
        ...(filters?.ownerId ? { ownerId: filters.ownerId } : {}),
        ...(filters?.createdFrom || filters?.createdTo ? { createdAt: {
          ...(filters.createdFrom ? { gte: new Date(filters.createdFrom) } : {}),
          ...(filters.createdTo ? { lte: new Date(filters.createdTo) } : {}),
        } } : {}),
        ...(input.after
          ? {
              OR: [
                { createdAt: { lt: new Date(input.after.createdAt) } },
                { createdAt: new Date(input.after.createdAt), id: { lt: input.after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      include: {
        currentVersion: {
          select: {
            id: true,
            sequence: true,
            createdAt: true,
            _count: {
              select: {
                reviewAnnotations: { where: { status: 'open' } },
              },
            },
            finalExportOperations: {
              where: { operation: { status: 'succeeded' } },
              select: {
                outputArtifactId: true,
                outputAspectRatio: true,
              },
              orderBy: [{ createdAt: 'asc' }, { operationId: 'asc' }],
              take: 1000,
            },
          },
        },
        publicOperations: {
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            type: true,
            status: true,
            phase: true,
            progressCompleted: true,
            progressTotal: true,
            progressUnit: true,
            errorCode: true,
            errorRetryable: true,
            updatedAt: true,
          },
        },
      },
    })

    return rows.map((row) => {
      const project = createProject({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        status: row.status as ProjectStatus,
        objective: row.objective ?? undefined,
        format: row.format ?? undefined,
        locale: row.locale ?? undefined,
        ownerId: row.ownerId ?? undefined,
        currentVersionId: row.currentVersionId ?? undefined,
        createdBy: {
          type: row.createdByType as CommandActorType,
          id: row.createdById,
        },
        createdAt: row.createdAt.toISOString(),
      })
      const operation = row.publicOperations[0]
      const operationProgress = operation?.progressCompleted === null ||
        operation?.progressCompleted === undefined
        ? undefined
        : {
            completed: operation.progressCompleted,
            ...(operation.progressTotal !== null
              ? { total: operation.progressTotal }
              : {}),
            ...(operation.progressUnit !== null
              ? { unit: operation.progressUnit }
              : {}),
          }
      const operationError = operation?.status === 'failed'
        ? {
            code: operation.errorCode ?? '',
            retryable: operation.errorRetryable ?? false,
          }
        : undefined
      const operationUpdatedAt = operation?.updatedAt.getTime() ?? 0
      const lastActivityAt = new Date(Math.max(
        row.updatedAt.getTime(),
        operationUpdatedAt,
      )).toISOString()
      return createProjectDashboardRecord({
        project,
        currentVersion: row.currentVersion
          ? {
              id: row.currentVersion.id,
              sequence: row.currentVersion.sequence,
              createdAt: row.currentVersion.createdAt.toISOString(),
            }
          : null,
        latestOperation: operation
          ? {
              id: operation.id,
              type: operation.type as Exclude<
                PublicOperationType,
                'production-batch-item'
              >,
              status: operation.status as PublicOperationStatus,
              phase: operation.phase as Exclude<
                PublicOperationPhase,
                'planning' | 'reviewing'
              >,
              ...(operationProgress ? { progress: operationProgress } : {}),
              ...(operationError ? { error: operationError } : {}),
              updatedAt: operation.updatedAt.toISOString(),
            }
          : null,
        openReviewIssueCount:
          row.currentVersion?._count.reviewAnnotations ?? 0,
        outputs: row.currentVersion?.finalExportOperations.map((output) => ({
          artifactId: output.outputArtifactId,
          aspectRatio: output.outputAspectRatio as OutputAspectRatio,
        })) ?? [],
        lastActivityAt,
      })
    })
  }
}
