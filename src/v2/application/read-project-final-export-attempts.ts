import { DomainError } from '../domain/errors.ts'
import type { ProjectFinalExportRepository } from './ports/project-final-export-repository.ts'

export function readProjectFinalExportAttemptsService(dependencies: {
  projects: ProjectFinalExportRepository
}) {
  return async function readProjectFinalExportAttempts(request: {
    workspaceId: string
    operationId: string
  }) {
    const history = await dependencies.projects.readAttemptHistory({
      workspaceId: request.workspaceId.trim(),
      operationId: request.operationId.trim(),
    })
    if (!history) {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Project final export operation was not found')
    }
    return history
  }
}
