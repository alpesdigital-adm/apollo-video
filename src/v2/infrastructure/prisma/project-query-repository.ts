import type { PrismaClient } from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type { ProjectQueryRepository } from '../../application/ports/project-query-repository.ts'
import { createProject, type Project, type ProjectStatus } from '../../domain/project.ts'
import type { CommandActorType } from '../../domain/edit-command.ts'

export class PrismaProjectQueryRepository implements ProjectQueryRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async listByWorkspace(workspaceId: string, limit: number): Promise<readonly Project[]> {
    const rows = await this.client.v2Project.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    })

    return rows.map((row) =>
      createProject({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        status: row.status as ProjectStatus,
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
