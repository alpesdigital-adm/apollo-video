import type { Project } from '../../domain/project.ts'

export interface ProjectQueryRepository {
  listByWorkspace(workspaceId: string, limit: number): Promise<readonly Project[]>
}
