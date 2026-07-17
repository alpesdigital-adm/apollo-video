import { assertDomain } from '../domain/errors.ts'

export type ProjectQuickAction = 'open' | 'review' | 'duplicate' | 'rename' | 'archive' | 'restore'

export interface QuickActionProject {
  id: string
  workspaceId: string
  name: string
  status: string
  currentVersionId?: string
  snapshotRefs?: readonly string[]
}

export interface ProjectQuickActionRepository {
  find(workspaceId: string, projectId: string): Promise<QuickActionProject | null>
  rename(workspaceId: string, projectId: string, name: string): Promise<QuickActionProject>
  duplicateCopyOnWrite(input: { workspaceId: string; projectId: string; name: string; actorId: string }): Promise<QuickActionProject>
  setArchived(input: { workspaceId: string; projectId: string; archived: boolean }): Promise<QuickActionProject>
}

export function projectQuickActionsService(dependencies: { projects: ProjectQuickActionRepository }) {
  return async function execute(input: {
    workspaceId: string; actorId: string; permissions: readonly string[]; projectId: string
    action: ProjectQuickAction; name?: string; confirmed?: boolean
  }) {
    const readOnly = input.action === 'open' || input.action === 'review'
    assertDomain(input.permissions.includes(readOnly ? 'projects:read' : 'projects:write'), 'AUTH_SCOPE_REQUIRED', `Missing ${readOnly ? 'projects:read' : 'projects:write'} permission`)
    const project = await dependencies.projects.find(input.workspaceId, input.projectId)
    assertDomain(project !== null, 'INVALID_PROJECT', 'Project was not found in the authenticated workspace')

    if (input.action === 'open' || input.action === 'review') {
      return Object.freeze({ project, destination: `/project/${project.id}${input.action === 'review' ? '?mode=review' : ''}` })
    }
    if (input.action === 'rename') {
      const name = input.name?.trim().replace(/\s+/g, ' ') ?? ''
      assertDomain(name.length >= 1 && name.length <= 120, 'INVALID_ARGUMENT', 'name must contain 1-120 characters')
      return Object.freeze({ project: await dependencies.projects.rename(input.workspaceId, project.id, name) })
    }
    if (input.action === 'duplicate') {
      return Object.freeze({ project: await dependencies.projects.duplicateCopyOnWrite({ workspaceId: input.workspaceId, projectId: project.id, name: `${project.name} (cópia)`.slice(0, 120), actorId: input.actorId }) })
    }
    if (input.action === 'archive') {
      assertDomain(input.confirmed === true, 'TOOL_CONFIRMATION_REQUIRED', 'archive requires explicit confirmation')
      return Object.freeze({ project: await dependencies.projects.setArchived({ workspaceId: input.workspaceId, projectId: project.id, archived: true }) })
    }
    assertDomain(project.status === 'archived', 'INVALID_PROJECT', 'Only archived projects can be restored')
    return Object.freeze({ project: await dependencies.projects.setArchived({ workspaceId: input.workspaceId, projectId: project.id, archived: false }) })
  }
}

export function optimisticProjectPatch<T extends { id: string }>(projects: readonly T[], projectId: string, patch: Partial<T>) {
  const previous = projects
  const next = projects.map((project) => project.id === projectId ? { ...project, ...patch } : project)
  return Object.freeze({ next: Object.freeze(next), rollback: () => previous })
}
