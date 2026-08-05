import { randomUUID } from 'node:crypto'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { projectProductionBatchItemOperation } from '../domain/batch-item-result.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { ProductionBatchRepository } from './ports/production-batch-repository.ts'
import { createBatchPartialRetryService } from './batch-partial-retries.ts'
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

export function retryPublicOperationService(dependencies: {
  operations: PublicOperationRepository
  productionBatches?: ProductionBatchRepository
  clock?: () => Date
  createId?: () => string
  createBatchRetryId?: () => string
  createBatchRetryJobId?: () => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? (() => `operation-control-${randomUUID()}`)
  return async function retryPublicOperationCommand(request: {
    workspaceId: string
    operationId: string
    actor: AuthenticatedExternalActor
  }) {
    requireScope(request.actor, 'operations:retry')
    const audit = materializeActorAuditContext(request.actor)
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match operation retry')
    const requestedAt = clock()
    const nextAttemptAt = new Date(requestedAt.getTime() + 1)
    assertDomain(
      !Number.isNaN(requestedAt.getTime()) && !Number.isNaN(nextAttemptAt.getTime()),
      'INVALID_ARGUMENT',
      'clock returned an invalid retry date',
    )
    const operationId = validateId(request.operationId, 'operationId')
    const batchItemRecord = await (
      dependencies.productionBatches?.findItemOperation({
        workspaceId,
        operationId,
      }) ?? null
    )
    if (batchItemRecord && await dependencies.operations.findById(
      workspaceId,
      operationId,
    )) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Public operation identity is ambiguous',
      )
    }
    if (batchItemRecord) {
      const operation = projectProductionBatchItemOperation(batchItemRecord)
      if (operation.status === 'succeeded') {
        throw new DomainError(
          'PUBLIC_OPERATION_RETRY_REJECTED',
          'A succeeded PublicOperation cannot be retried',
        )
      }
      if (operation.status !== 'failed') return operation
      requireScope(request.actor, 'projects:write')
      const failedStep = batchItemRecord.item.steps.find((step) =>
        step.state === 'failed')
      assertDomain(
        Boolean(failedStep?.error),
        'PUBLIC_OPERATION_RETRY_REJECTED',
        'Production batch item has no retryable failed step',
      )
      const result = await createBatchPartialRetryService({
        repository: dependencies.productionBatches!,
        clock: () => requestedAt,
        createRetryId: dependencies.createBatchRetryId ??
          (() => `batch-partial-retry-${randomUUID()}`),
        createJobId: dependencies.createBatchRetryJobId ??
          (() => `batch-partial-retry-job-${randomUUID()}`),
      })({
        workspaceId,
        batchId: batchItemRecord.batch.id,
        expectedBatchRevision: batchItemRecord.batch.revision,
        targets: [{
          itemId: batchItemRecord.item.id,
          step: failedStep!.step,
          expectedItemRevision: batchItemRecord.item.revision,
          expectedStepHash: failedStep!.stepHash,
        }],
        actor: request.actor,
        idempotencyKey: `operation-retry-${calculateCanonicalHash({
          schemaVersion: 'production-batch-item-operation-retry/v1',
          operationId,
          itemRevision: batchItemRecord.item.revision,
        })}`,
      })
      const item = result.batch.items.find((candidate) =>
        candidate.id === batchItemRecord.item.id)
      assertDomain(
        Boolean(item),
        'PERSISTENCE_CONFLICT',
        'Retried production batch item is missing',
      )
      return projectProductionBatchItemOperation({
        batch: result.batch,
        item: item!,
      })
    }
    const record = await dependencies.operations.retry({
      workspaceId,
      operationId,
      commandId: validateId(createId(), 'commandId'),
      authenticationAudit: audit,
      requestedAt: requestedAt.toISOString(),
      nextAttemptAt: nextAttemptAt.toISOString(),
    })
    if (!record) {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Public operation was not found')
    }
    return record.operation
  }
}
