import { listPublicOperationsService } from './list-public-operations.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

export function listDeadLetterOperationsService(dependencies: {
  operations: PublicOperationRepository
}) {
  const list = listPublicOperationsService(dependencies)
  return async function listDeadLetterOperations(request: {
    workspaceId: string
    limit?: number
    after?: string
    type?: string
    targetId?: string
  }) {
    return list({
      ...request,
      status: 'failed',
      deadLettered: true,
    })
  }
}
