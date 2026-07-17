import type { Project } from '../../domain/project.ts'

export interface ProjectQueryRepository {
  listByWorkspace(input: {
    workspaceId: string
    limit: number
    after?: { createdAt: string; id: string }
    filters?: {
      text?: string
      status?: string
      objective?: string
      format?: string
      locale?: string
      createdFrom?: string
      createdTo?: string
      ownerId?: string
    }
  }): Promise<readonly Project[]>
}
