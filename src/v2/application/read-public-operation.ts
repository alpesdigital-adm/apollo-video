import { DomainError } from '../domain/errors.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { ProductionBatchRepository } from './ports/production-batch-repository.ts'
import { projectProductionBatchItemOperation } from '../domain/batch-item-result.ts'

export function readPublicOperationService(dependencies: {
  operations: PublicOperationRepository
  productionBatches?: ProductionBatchRepository
}) {
  return async function readPublicOperation(request: {
    workspaceId: string
    operationId: string
  }) {
    const workspaceId = request.workspaceId.trim()
    const operationId = request.operationId.trim()
    const [record, batchItem] = await Promise.all([
      dependencies.operations.findById(workspaceId, operationId),
      dependencies.productionBatches?.findItemOperation({
        workspaceId,
        operationId,
      }) ?? null,
    ])
    if (record && batchItem) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Public operation identity is ambiguous',
      )
    }
    if (!record && !batchItem) {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Public operation was not found')
    }
    return record?.operation ?? projectProductionBatchItemOperation(batchItem!)
  }
}
