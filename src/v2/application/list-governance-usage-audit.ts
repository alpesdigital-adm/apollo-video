import { listPublicOperationsService } from './list-public-operations.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

export function listGovernanceUsageAuditService(dependencies: { operations: PublicOperationRepository }) {
  const list = listPublicOperationsService(dependencies)
  return async function query(input: { workspaceId: string; limit?: number; after?: string }) {
    const page = await list(input)
    return Object.freeze({
      entries: Object.freeze(page.operations.map((operation) => Object.freeze({
        id: operation.id, clientId: operation.clientId, action: operation.type, status: operation.status,
        target: Object.freeze({ type: operation.target.type, id: operation.target.id }),
        usage: Object.freeze({ unit: 'operation' as const, quantity: 1 }), createdAt: operation.createdAt, updatedAt: operation.updatedAt,
      }))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    })
  }
}
