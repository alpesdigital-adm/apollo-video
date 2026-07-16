import type { Project } from '../../domain/project.ts'

export interface ProjectQueryRepository {
  listByWorkspace(input: {
    workspaceId: string
    limit: number
    after?: { createdAt: string; id: string }
  }): Promise<readonly Project[]>
}
