import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import type { ProjectQueryRepository } from '../../application/ports/project-query-repository.ts'
import { createProject, type Project, type ProjectStatus } from '../../domain/project.ts'
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
  }): Promise<readonly Project[]> {
    const filters = input.filters
    const rows = await this.client.v2Project.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(filters?.text ? { name: { contains: filters.text } } : {}),
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
    })

    return rows.map((row) =>
      createProject({
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
      }),
    )
  }
}
