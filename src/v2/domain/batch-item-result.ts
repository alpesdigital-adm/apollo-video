import { assertDomain } from './errors.ts'

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
