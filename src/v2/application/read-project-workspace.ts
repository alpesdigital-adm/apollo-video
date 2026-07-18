import { DomainError, assertDomain } from '../domain/errors.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'

export function readProjectWorkspaceService(dependencies: {
  projects: ProjectWorkspaceQueryRepository
  operations: PublicOperationRepository
}) {
  return async function read(input: { workspaceId: string; projectId: string }) {
    const workspaceId = input.workspaceId.trim()
    const projectId = input.projectId.trim()
    assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workspaceId) && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(projectId), 'INVALID_ARGUMENT', 'Workspace project identity is invalid')
    const record = await dependencies.projects.read({ workspaceId, projectId })
    if (!record) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    const operations = (await Promise.all(record.operationIds.map((operationId) => dependencies.operations.findById(workspaceId, operationId))))
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .map((item) => item.operation)
    return Object.freeze({ ...record, operations: Object.freeze(operations) })
  }
}
