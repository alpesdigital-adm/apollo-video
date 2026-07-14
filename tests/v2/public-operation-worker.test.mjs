import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advancePublicOperationPhase,
  cancelPublicOperation,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import {
  calculatePublicOperationRetryDelayMs,
  runNextPublicOperationService,
} from '../../src/v2/application/run-public-operation-worker.ts'

function createClock() {
  let current = Date.parse('2026-07-14T12:00:00.000Z')
  return () => new Date((current += 100))
}

function createOperations() {
  let operation = createQueuedPublicOperation({
    id: 'operation-worker-test',
    workspaceId: 'workspace-worker-test',
    clientId: 'client-worker-test',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-worker-test',
      manifestId: 'manifest-worker-test',
    },
    maxAttempts: 2,
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  let lease
  let denyHeartbeat = false
  let allowExpiredClaim = false
  const context = Object.freeze({
    authorizationId: 'authorization-worker-test',
    inputHash: 'a'.repeat(64),
  })
  const record = () => ({ operation, context })
  const matches = (input) =>
    lease &&
    lease.owner === input.leaseOwner &&
    lease.attempt === input.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(input.now)

  return {
    get operation() { return operation },
    cancel(canceledAt) {
      operation = cancelPublicOperation(operation, canceledAt)
      lease = undefined
    },
    loseLease() { denyHeartbeat = true },
    expireLease() { allowExpiredClaim = true },
    repository: {
      async findById() { return record() },
      async findReplay() { return null },
      async createOrReplay() { throw new Error('not used') },
      async claimNext(input) {
        if (
          !['queued', 'retrying'].includes(operation.status) &&
          !(operation.status === 'running' && allowExpiredClaim)
        ) return null
        if (
          operation.status === 'retrying' &&
          Date.parse(operation.nextAttemptAt) > Date.parse(input.now)
        ) return null
        operation = startPublicOperationAttempt(operation, input.now)
        allowExpiredClaim = false
        lease = {
          owner: input.leaseOwner,
          attempt: operation.attempt,
          heartbeatAt: input.now,
          expiresAt: input.leaseUntil,
        }
        denyHeartbeat = false
        return { ...record(), lease: Object.freeze({ ...lease }) }
      },
      async heartbeat(input) {
        if (denyHeartbeat || !matches(input)) return false
        lease = { ...lease, heartbeatAt: input.now, expiresAt: input.leaseUntil }
        return true
      },
      async advancePhase(input) {
        if (!matches(input)) return false
        operation = advancePublicOperationPhase(operation, input.phase, input.now)
        return true
      },
      async succeed(input) {
        if (!matches(input)) return null
        operation = succeedPublicOperation(operation, input.now)
        lease = undefined
        return record()
      },
      async failOrRetry(input) {
        if (!matches(input)) return null
        operation = retryOrFailPublicOperation(
          operation,
          input.error,
          input.now,
          input.nextAttemptAt,
        )
        lease = undefined
        return record()
      },
    },
  }
}

function receipt() {
  const safe = Object.freeze({
    schemaVersion: 'authorized-render-receipt/v1',
    authorizationId: 'authorization-worker-test',
    artifactId: 'artifact-worker-test',
    manifestId: 'manifest-worker-test',
    inputHash: 'a'.repeat(64),
    revalidationHash: 'b'.repeat(64),
    output: Object.freeze({
      outputKey: 'private/output.mp4',
      outputSha256: 'c'.repeat(64),
      byteSize: 1024,
      committedAt: '2026-07-14T12:00:01.000Z',
    }),
  })
  return Object.freeze({
    ...safe,
    getOutputKey() { return 'workspaces/test/renders/output.mp4' },
    toJSON() { return safe },
  })
}

function createCheckpoints() {
  let checkpoint = null
  return {
    get checkpoint() { return checkpoint },
    repository: {
      async findByOperationId() { return checkpoint },
      async record(input) {
        checkpoint = {
          operationId: input.operationId,
          outputKey: input.outputKey,
          output: input.output,
        }
        return { checkpoint, replayed: false }
      },
    },
  }
}

test('durable worker fences promotion with heartbeat and persists a safe terminal result', async () => {
  const operations = createOperations()
  const checkpoints = createCheckpoints()
  let committed = false
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: checkpoints.repository,
    clock: createClock(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    async render(request) {
      await request.beforeCommit()
      committed = true
      return receipt()
    },
  })
  const outcome = await runNext('worker-success-test')
  assert.deepEqual(outcome, {
    operationId: 'operation-worker-test',
    status: 'succeeded',
  })
  assert.equal(committed, true)
  assert.equal(operations.operation.status, 'succeeded')
  assert.equal(checkpoints.checkpoint.output.outputSha256, 'c'.repeat(64))
  assert.deepEqual(operations.operation.result.resource, operations.operation.target)
  const serialized = JSON.stringify(operations.operation)
  assert.equal(serialized.includes('private/output.mp4'), false)
  assert.equal(serialized.includes('authorization-worker-test'), false)
})

test('lost lease aborts before commit and cannot publish a stale result', async () => {
  const operations = createOperations()
  const checkpoints = createCheckpoints()
  let committed = false
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: checkpoints.repository,
    clock: createClock(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    async render(request) {
      operations.loseLease()
      await request.beforeCommit()
      committed = true
      return receipt()
    },
  })
  const outcome = await runNext('worker-stale-test')
  assert.equal(outcome.status, 'lease-lost')
  assert.equal(committed, false)
  assert.equal(operations.operation.status, 'running')
  assert.equal(checkpoints.checkpoint, null)
})

test('cancellation invalidates the lease and aborts before output commit', async () => {
  const operations = createOperations()
  const checkpoints = createCheckpoints()
  let committed = false
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: checkpoints.repository,
    clock: createClock(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    async render(request) {
      operations.cancel('2026-07-14T12:00:00.250Z')
      await request.beforeCommit()
      committed = true
      return receipt()
    },
  })
  const outcome = await runNext('worker-canceled-test')
  assert.equal(outcome.status, 'lease-lost')
  assert.equal(operations.operation.status, 'canceled')
  assert.equal(committed, false)
  assert.equal(checkpoints.checkpoint, null)
})

test('retryable failure is reclaimed after restart and succeeds on the next attempt', async () => {
  const operations = createOperations()
  const checkpoints = createCheckpoints()
  let renders = 0
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: checkpoints.repository,
    clock: createClock(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 1_000,
    async render(request) {
      renders += 1
      if (renders === 1) throw new Error('private renderer detail')
      await request.beforeCommit()
      return receipt()
    },
  })
  assert.equal((await runNext('worker-restart-one')).status, 'retrying')
  assert.equal(operations.operation.attempt, 1)
  assert.equal(operations.operation.nextAttemptAt, '2026-07-14T12:00:00.400Z')
  assert.equal((await runNext('worker-restart-two')).status, 'succeeded')
  assert.equal(operations.operation.attempt, 2)
  assert.equal(JSON.stringify(operations.operation).includes('private renderer detail'), false)
})

test('retry exhaustion is terminal and marked for dead-letter handling', async () => {
  const operations = createOperations()
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: createCheckpoints().repository,
    clock: createClock(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 1_000,
    async render() {
      throw new Error('private repeated renderer detail')
    },
  })
  assert.equal((await runNext('worker-dead-letter-one')).status, 'retrying')
  assert.equal((await runNext('worker-dead-letter-two')).status, 'failed')
  assert.equal(operations.operation.attempt, 2)
  assert.equal(operations.operation.deadLetteredAt, operations.operation.completedAt)
  assert.equal(operations.operation.error.retryable, false)
  assert.equal(JSON.stringify(operations.operation).includes('private repeated'), false)
})

test('retry delay grows exponentially and caps without overflow', () => {
  const calculate = (attempt) => calculatePublicOperationRetryDelayMs({
    attempt,
    baseDelayMs: 5_000,
    maxDelayMs: 300_000,
  })
  assert.deepEqual([1, 2, 3, 4].map(calculate), [5_000, 10_000, 20_000, 40_000])
  assert.equal(calculate(8), 300_000)
  assert.equal(calculate(1_000), 300_000)
  assert.throws(
    () => calculatePublicOperationRetryDelayMs({
      attempt: 0,
      baseDelayMs: 5_000,
      maxDelayMs: 300_000,
    }),
    { code: 'INVALID_PUBLIC_OPERATION' },
  )
})

test('output committed before checkpoint is recovered by the next fenced attempt', async () => {
  const operations = createOperations()
  let checkpointWrites = 0
  let renders = 0
  const checkpoints = {
    async findByOperationId() { return null },
    async record(input) {
      checkpointWrites += 1
      if (checkpointWrites === 1) return null
      return {
        checkpoint: { operationId: input.operationId, output: input.output },
        replayed: false,
      }
    },
  }
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints,
    clock: createClock(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    async render(request) {
      renders += 1
      await request.beforeCommit()
      return receipt()
    },
  })

  assert.equal((await runNext('worker-after-commit-one')).status, 'lease-lost')
  assert.equal(operations.operation.status, 'running')
  operations.expireLease()
  assert.equal((await runNext('worker-after-commit-two')).status, 'succeeded')
  assert.equal(operations.operation.attempt, 2)
  assert.equal(checkpointWrites, 2)
  assert.equal(renders, 2)
})
