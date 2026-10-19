import { DomainError, assertDomain } from '../domain/errors.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'

export function readProjectWorkspaceService(dependencies: {
  projects: ProjectWorkspaceQueryRepository
}) {
  return async function read(input: { workspaceId: string; projectId: string }) {
    const workspaceId = input.workspaceId.trim()
    const projectId = input.projectId.trim()
    assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workspaceId) && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(projectId), 'INVALID_ARGUMENT', 'Workspace project identity is invalid')
    const record = await dependencies.projects.read({ workspaceId, projectId })
    if (!record) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    if (record.reviewAvailability.requestedVersionId !== (record.version?.id ?? null) ||
      (record.reviewAvailability.proxyReview.state === 'available' && record.reviewAvailability.proxyReview.sourceVersionId !== record.version?.id)
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace review availability version is inconsistent')
    return record
  }
}
