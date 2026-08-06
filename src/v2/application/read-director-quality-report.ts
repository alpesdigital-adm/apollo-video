import { DomainError, assertDomain } from '../domain/errors.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'

function identifier(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

export function readDirectorQualityReportService(dependencies: {
  repository: DirectorRunRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    directorRunId: string
  }) {
    const result = await dependencies.repository.readQualityReport({
      workspaceId: identifier(input.workspaceId, 'workspaceId'),
      projectId: identifier(input.projectId, 'projectId'),
      directorRunId: identifier(input.directorRunId, 'directorRunId'),
    })
    if (!result) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Director quality report was not found')
    }
    return result
  }
}
