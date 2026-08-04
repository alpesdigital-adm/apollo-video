import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  readCompletedIdempotencyResponse,
} from '../../src/v2/infrastructure/prisma/idempotency-record-persistence.ts'

const fingerprint = 'a'.repeat(64)

function record(overrides = {}) {
  return {
    id: 'idempotency-record-fixture',
    requestFingerprint: fingerprint,
    status: 'completed',
    responseStatus: 201,
    responseJson: '{"resourceId":"resource-fixture"}',
    ...overrides,
  }
}

test('T-FR-245 canonical idempotency replay accepts only one completed 2xx object response', () => {
  const response = readCompletedIdempotencyResponse(record(), fingerprint)
  assert.deepEqual(response, { resourceId: 'resource-fixture' })
  assert.ok(Object.isFrozen(response))
})

test('T-FR-245 canonical idempotency replay distinguishes request drift from corrupted persistence', () => {
  assert.throws(
    () => readCompletedIdempotencyResponse(record(), 'b'.repeat(64)),
    (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  for (const malformed of [
    { status: 'processing', responseStatus: null, responseJson: null },
    { status: 'completed', responseStatus: null },
    { status: 'completed', responseStatus: 409 },
    { responseJson: '[]' },
    { responseJson: 'null' },
    { responseJson: '{broken' },
    { responseJson: JSON.stringify({ value: 'x'.repeat(1_048_576) }) },
  ]) {
    assert.throws(
      () => readCompletedIdempotencyResponse(
        record(malformed),
        fingerprint,
      ),
      (error) => error?.code === 'PERSISTENCE_CONFLICT',
    )
  }
})

test('T-FR-245 every shared-ledger consumer uses the canonical replay reader', () => {
  const repositoryNames = [
    'api-client-repository.ts',
    'media-artifact-lifecycle-repository.ts',
    'project-creation-repository.ts',
    'project-duplication-repository.ts',
    'webhook-delivery-repository.ts',
    'webhook-endpoint-creation-repository.ts',
    'webhook-event-replay-repository.ts',
    'webhook-signing-secret-provisioning-repository.ts',
    'webhook-signing-secret-rotation-repository.ts',
    'webhook-subscription-creation-repository.ts',
  ]
  for (const repositoryName of repositoryNames) {
    const source = readFileSync(
      new URL(
        `../../src/v2/infrastructure/prisma/${repositoryName}`,
        import.meta.url,
      ),
      'utf8',
    )
    assert.match(source, /readCompletedIdempotencyResponse\(/)
    assert.doesNotMatch(source, /JSON\.parse\(record\.responseJson/)
    assert.doesNotMatch(source, /record\.status !== 'completed'/)
  }
})

test('T-FR-245 PostgreSQL enforces the same response, time and size matrix', () => {
  const migration = readFileSync(
    new URL(
      '../../prisma/v2/migrations/20260805090000_idempotency_record_invariants/migration.sql',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(migration, /idempotency_records_response_matrix_check/)
  assert.match(migration, /"status" = 'processing'/)
  assert.match(migration, /"status" = 'completed'/)
  assert.match(migration, /"responseStatus" BETWEEN 200 AND 299/)
  assert.match(migration, /jsonb_typeof\("responseJson"::jsonb\) = 'object'/)
  assert.match(migration, /idempotency_records_time_order_check/)
  assert.match(migration, /idempotency_records_response_size_check/)
})
