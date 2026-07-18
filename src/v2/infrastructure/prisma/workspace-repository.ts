import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { createWorkspace, type Workspace, type WorkspaceStatus } from '../../domain/workspace.ts'
import type { WorkspaceRepository } from '../../application/ports/workspace-repository.ts'

export class PrismaWorkspaceRepository implements WorkspaceRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async create(workspace: Workspace): Promise<Workspace> {
    const row = await this.client.v2Workspace.create({
      data: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        status: workspace.status,
        createdAt: new Date(workspace.createdAt),
      },
    })

    return createWorkspace({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status as WorkspaceStatus,
      createdAt: row.createdAt.toISOString(),
    })
  }

  async findById(workspaceId: string): Promise<Workspace | null> {
    const row = await this.client.v2Workspace.findUnique({ where: { id: workspaceId } })
    if (!row) return null

    return createWorkspace({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status as WorkspaceStatus,
      createdAt: row.createdAt.toISOString(),
    })
  }
}
