import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseCreateContiguousExtractionBody,
  presentContiguousExtraction,
} from '../../src/v2/public-api/contiguous-extraction-contract.ts'

test('T-FR-134 public parser accepts only objective, topic and bounded timing', () => {
  assert.deepEqual(
    parseCreateContiguousExtractionBody({
      objective: ' educação ',
      topic: ' aquisição ',
      targetDurationMs: 120_000,
      toleranceMs: 15_000,
      fps: 30,
    }),
    {
      objective: 'educação',
      topic: 'aquisição',
      targetDurationMs: 120_000,
      toleranceMs: 15_000,
      fps: 30,
    },
  )
  assert.throws(
    () => parseCreateContiguousExtractionBody({
      objective: 'educação',
      topic: 'aquisição',
      targetDurationMs: 120_000,
      toleranceMs: 15_000,
      fps: 30,
      moments: [],
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => parseCreateContiguousExtractionBody({
      objective: 'educação',
      topic: 'aquisição',
      targetDurationMs: 120_000,
      toleranceMs: 120_001,
      fps: 30,
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

test('T-FR-134 public presentation excludes idempotency and request fingerprint', () => {
  const value = {
    result: {
      id: 'contiguous-public-1',
      schemaVersion: 'contiguous-extraction-result/v1',
    },
    requestFingerprint: 'a'.repeat(64),
    idempotencyKey: 'contiguous-public-key',
    createdBy: {
      type: 'api-client',
      id: 'client-contiguous-public',
    },
    createdAt: '2026-07-30T23:00:00.000Z',
  }
  assert.deepEqual(presentContiguousExtraction(value), {
    ...value.result,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
  })
  assert.equal(
    'requestFingerprint' in presentContiguousExtraction(value),
    false,
  )
  assert.equal(
    'idempotencyKey' in presentContiguousExtraction(value),
    false,
  )
})
