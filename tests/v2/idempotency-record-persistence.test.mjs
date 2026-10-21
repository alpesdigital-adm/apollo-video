import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_IDEMPOTENCY_WINNER_WAIT,
  awaitCommittedIdempotencyWinner,
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
    'output-version-bundle-repository.ts',
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

test('idempotency winner wait reads once when the winner is already committed', async () => {
  const sleeps = []
  const winner = await awaitCommittedIdempotencyWinner(
    async () => 'winner',
    { delaysMs: [1, 2], async sleep(ms) { sleeps.push(ms) } },
  )
  assert.equal(winner, 'winner')
  assert.deepEqual(sleeps, [])
})

test('idempotency winner wait re-reads until the in-flight winner commits and then stops', async () => {
  const sleeps = []
  let reads = 0
  const winner = await awaitCommittedIdempotencyWinner(
    async () => (++reads > 3 ? 'late-winner' : null),
    { delaysMs: [1, 2, 3, 4, 5], async sleep(ms) { sleeps.push(ms) } },
  )
  assert.equal(winner, 'late-winner')
  assert.deepEqual(sleeps, [1, 2, 3])
  assert.equal(reads, 4)
})

test('idempotency winner wait is bounded and reports no winner', async () => {
  const sleeps = []
  let reads = 0
  const winner = await awaitCommittedIdempotencyWinner(
    async () => { reads += 1; return null },
    { delaysMs: [1, 2], async sleep(ms) { sleeps.push(ms) } },
  )
  assert.equal(winner, null)
  assert.deepEqual(sleeps, [1, 2])
  assert.equal(reads, 3)
  assert.ok(
    DEFAULT_IDEMPOTENCY_WINNER_WAIT.delaysMs.reduce((total, ms) => total + ms, 0) <= 2_000,
    'default wait must stay a bounded fraction of the request budget',
  )
})

test('idempotency winner wait never retries a final mismatch raised while reading', async () => {
  let reads = 0
  await assert.rejects(
    () => awaitCommittedIdempotencyWinner(
      async () => { reads += 1; throw Object.assign(new Error('mismatch'), { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }) },
      { delaysMs: [1, 2], async sleep() {} },
    ),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(reads, 1)
})
