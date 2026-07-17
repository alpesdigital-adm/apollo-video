import assert from 'node:assert/strict'
import test from 'node:test'
import { createBatchItemResult } from '../../src/v2/domain/batch-item-result.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'

test('batch items expose independent operation status and retry without monolithic result', () => {
  const failed = createBatchItemResult({ itemId: 'item-2', operationId: 'operation-2', status: 'failed', retryable: true, error: { code: 'TIMEOUT', message: 'Provider timed out' }, updatedAt: '2026-07-17T00:00:00Z' })
  assert.equal(failed.operationId, 'operation-2')
  assert.equal('result' in failed, false)
  const capabilities = new Set(FOUNDATION_CAPABILITIES.map((item) => item.id))
  assert.equal(capabilities.has('apollo.operations.read'), true)
  assert.equal(capabilities.has('apollo.operations.retry'), true)
})

test('batch item state rejects ambiguous result, error and retry combinations', () => {
  const base = { itemId: 'item-1', operationId: 'operation-1', updatedAt: '2026-07-17T00:00:00Z' }
  assert.throws(() => createBatchItemResult({ ...base, status: 'succeeded', retryable: true, resultRef: 'artifact-1' }), /retryable/)
  assert.throws(() => createBatchItemResult({ ...base, status: 'failed', retryable: false }), /error/)
})
