import { DomainError, assertDomain } from '../domain/errors.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized),
    'INVALID_ARGUMENT',
    `${field} must contain 3 to 128 safe characters`,
  )
  return normalized
}

export function retryPublicOperationService(dependencies: {
  operations: PublicOperationRepository
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function retryPublicOperationCommand(request: {
    workspaceId: string
    operationId: string
  }) {
    const requestedAt = clock()
    const nextAttemptAt = new Date(requestedAt.getTime() + 1)
    assertDomain(
      !Number.isNaN(requestedAt.getTime()) && !Number.isNaN(nextAttemptAt.getTime()),
      'INVALID_ARGUMENT',
      'clock returned an invalid retry date',
    )
    const record = await dependencies.operations.retry({
      workspaceId: validateId(request.workspaceId, 'workspaceId'),
      operationId: validateId(request.operationId, 'operationId'),
      requestedAt: requestedAt.toISOString(),
      nextAttemptAt: nextAttemptAt.toISOString(),
    })
    if (!record) {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Public operation was not found')
    }
    return record.operation
  }
}
