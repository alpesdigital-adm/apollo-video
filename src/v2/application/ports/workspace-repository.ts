import type { Workspace } from '../../domain/workspace.ts'

export interface WorkspaceRepository {
  create(workspace: Workspace): Promise<Workspace>
  findById(workspaceId: string): Promise<Workspace | null>
}
