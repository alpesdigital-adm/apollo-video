import { DomainError } from '../domain/errors.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

export function readPublicOperationService(dependencies: {
  operations: PublicOperationRepository
}) {
  return async function readPublicOperation(request: {
    workspaceId: string
    operationId: string
  }) {
    const record = await dependencies.operations.findById(
      request.workspaceId.trim(),
      request.operationId.trim(),
    )
    if (!record) {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Public operation was not found')
    }
    return record.operation
  }
}
