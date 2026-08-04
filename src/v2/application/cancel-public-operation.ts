import { randomUUID } from 'node:crypto'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized),
    'INVALID_ARGUMENT',
    `${field} must contain 3 to 128 safe characters`,
  )
  return normalized
}

export function cancelPublicOperationService(dependencies: {
  operations: PublicOperationRepository
  clock?: () => Date
  createId?: () => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? (() => `operation-control-${randomUUID()}`)
  return async function cancelPublicOperationCommand(request: {
    workspaceId: string
    operationId: string
    actor: AuthenticatedExternalActor
  }) {
    requireScope(request.actor, 'operations:cancel')
    const audit = materializeActorAuditContext(request.actor)
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match operation cancellation')
    const canceledAt = clock()
    assertDomain(
      !Number.isNaN(canceledAt.getTime()),
      'INVALID_ARGUMENT',
      'clock returned an invalid date',
    )
    const record = await dependencies.operations.cancel({
      workspaceId,
      operationId: validateId(request.operationId, 'operationId'),
      commandId: validateId(createId(), 'commandId'),
      authenticationAudit: audit,
      canceledAt: canceledAt.toISOString(),
    })
    if (!record) {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Public operation was not found')
    }
    return record.operation
  }
}
