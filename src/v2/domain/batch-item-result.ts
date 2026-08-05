import { assertDomain } from './errors.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  rehydratePublicOperation,
  type PublicOperation,
} from './public-operation.ts'
import type { BatchItem, ProductionBatch } from './production-batch.ts'

export const BATCH_ITEM_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number]

export interface BatchItemResult {
  itemId: string
  operationId: string
  status: BatchItemStatus
  retryable: boolean
  resultRef?: string
  error?: Readonly<{ code: string; message: string }>
  updatedAt: string
}

export function createBatchItemResult(input: BatchItemResult): Readonly<BatchItemResult> {
  assertDomain(input.itemId.length >= 1 && input.itemId.length <= 128 && input.operationId.length >= 3 && input.operationId.length <= 128, 'INVALID_ARGUMENT', 'batch item identity is invalid')
  assertDomain(BATCH_ITEM_STATUSES.includes(input.status), 'INVALID_ARGUMENT', 'batch item status is invalid')
  assertDomain(!Number.isNaN(Date.parse(input.updatedAt)), 'INVALID_ARGUMENT', 'batch item timestamp is invalid')
  assertDomain(input.status === 'failed' || !input.retryable, 'INVALID_ARGUMENT', 'only failed batch items can be retryable')
  assertDomain(!(input.resultRef && input.error), 'INVALID_ARGUMENT', 'batch item cannot contain result and error together')
  assertDomain(input.status === 'succeeded' ? Boolean(input.resultRef) : !input.resultRef, 'INVALID_ARGUMENT', 'batch item resultRef is inconsistent')
  assertDomain(input.status === 'failed' ? Boolean(input.error) : !input.error, 'INVALID_ARGUMENT', 'batch item error is inconsistent')
  return Object.freeze({ ...input, ...(input.error ? { error: Object.freeze({ ...input.error }) } : {}), updatedAt: new Date(input.updatedAt).toISOString() })
}

export function productionBatchItemOperationId(input: {
  workspaceId: string
  batchId: string
  itemId: string
}): string {
  return `production-batch-item-operation-${calculateCanonicalHash({
    schemaVersion: 'production-batch-item-operation-id/v1',
    ...input,
  })}`
}

function itemStatus(item: Readonly<BatchItem>): BatchItemStatus {
  if (item.state === 'queued') return 'queued'
  if (item.state === 'completed') return 'succeeded'
  if (item.state === 'failed') return 'failed'
  if (item.state === 'cancelled' || item.state === 'superseded') {
    return 'canceled'
  }
  return 'running'
}

function publicErrorCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 64)
}

export function projectProductionBatchItemOperation(input: {
  batch: Readonly<ProductionBatch>
  item: Readonly<BatchItem>
}): Readonly<PublicOperation> {
  const { batch, item } = input
  const status = itemStatus(item)
  const failedStep = item.steps.find((step) => step.state === 'failed')
  const activeStep = item.steps.find((step) => step.state === 'running') ??
    item.steps.find((step) => step.state === 'queued')
  const completedSteps = item.steps.filter((step) =>
    step.state === 'completed').length
  const attempt = Math.max(0, ...item.steps.map((step) => step.attempt))
  const completedAt = ['succeeded', 'failed', 'canceled'].includes(status)
    ? item.updatedAt
    : undefined
  const target = Object.freeze({
    type: 'production-batch-item' as const,
    id: item.id,
    batchId: batch.id,
  })
  return rehydratePublicOperation({
    schemaVersion: 'public-operation/v1',
    id: productionBatchItemOperationId({
      workspaceId: batch.workspaceId,
      batchId: batch.id,
      itemId: item.id,
    }),
    workspaceId: batch.workspaceId,
    projectId: batch.projectId,
    clientId: batch.createdBy.id,
    type: 'production-batch-item',
    status,
    phase: status === 'queued'
      ? 'queued'
      : status === 'succeeded'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : status === 'canceled'
            ? 'canceled'
            : activeStep?.step ?? 'planning',
    progress: {
      completed: completedSteps,
      total: item.steps.length,
      unit: 'batch-step',
    },
    cancelable: status === 'queued' || status === 'running',
    retryable: status === 'failed' && Boolean(failedStep?.error),
    target,
    ...(status === 'succeeded' ? { result: { resource: target } } : {}),
    ...(status === 'failed' && failedStep?.error
      ? {
          error: {
            code: publicErrorCode(failedStep.error.code),
            message: `Production batch item failed during ${failedStep.step}.`,
            retryable: true,
          },
        }
      : {}),
    attempt,
    maxAttempts: Math.max(3, attempt + 1),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(completedAt ? { completedAt } : {}),
  })
}

export function createProductionBatchItemResult(input: {
  batch: Readonly<ProductionBatch>
  item: Readonly<BatchItem>
}): Readonly<BatchItemResult> {
  const operation = projectProductionBatchItemOperation(input)
  return createBatchItemResult({
    itemId: input.item.id,
    operationId: operation.id,
    status: operation.status as BatchItemStatus,
    retryable: operation.retryable,
    ...(operation.status === 'succeeded'
      ? { resultRef: input.item.artifactIds.at(-1) }
      : {}),
    ...(operation.error
      ? {
          error: {
            code: operation.error.code,
            message: operation.error.message,
          },
        }
      : {}),
    updatedAt: operation.updatedAt,
  })
}
