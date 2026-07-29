import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  createLongFormIndexWorkflow,
  resumeLongFormIndexWorkflow,
  startLongFormIndexStage,
} from '../../src/v2/domain/long-form-index-workflow.ts'
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import {
  runNextLongFormIndexOperationService,
} from '../../src/v2/application/run-long-form-index-worker.ts'

const sha = (value) =>
  createHash('sha256').update(value).digest('hex')
const stageNames = [
  'probe',
  'transcript',
  'diarization',
  'chunks',
  'moments',
]
const versions = Object.freeze(Object.fromEntries(
  stageNames.map((stage) => [
    stage,
    {
      provider: stage === 'probe' ? 'ffprobe' : 'apollo',
      model: `${stage}-model`,
      version: 'v1',
    },
  ]),
))
const stageBudgets = Object.freeze(Object.fromEntries(
  stageNames.map((stage) => [
    stage,
    {
      estimatedCostMinorUnits: 10,
      maximumCostMinorUnits: 50,
      maximumElapsedMs: 60_000,
    },
  ]),
))

function initialWorkflow() {
  return createLongFormIndexWorkflow({
    id: 'workflow-long-form-worker',
    workspaceId: 'workspace-long-form-worker',
    projectId: 'project-long-form-worker',
    sourceArtifactId: 'artifact-long-form-worker',
    sourceArtifactSha256: sha('artifact'),
    sourceManifestId: 'manifest-long-form-worker',
    sourceManifestHash: sha('manifest'),
    sourceTranscriptId: 'transcript-long-form-worker',
    sourceTranscriptHash: sha('transcript'),
    durationMs: 7_200_000,
    versions,
    stageBudgets,
    reusableOutputs: {
      probe: { outputHash: sha('probe'), resultCount: 1 },
      transcript: {
        outputHash: sha('transcript'),
        resultCount: 3200,
      },
    },
    budget: {
      currency: 'USD',
      maximumCostMinorUnits: 500,
      maximumElapsedMs: 300_000,
      maximumConcurrency: 4,
    },
    createdByClientId: 'client-long-form-worker',
    createdAt: '2026-07-29T18:00:00.000Z',
  })
}

function workerFixture(options = {}) {
  let workflow = initialWorkflow()
  let operation = createQueuedPublicOperation({
    id: 'operation-long-form-worker',
    workspaceId: workflow.workspaceId,
    clientId: workflow.createdByClientId,
    type: 'long-form-index',
    target: {
      type: 'media-artifact',
      id: workflow.sourceArtifactId,
      manifestId: workflow.sourceManifestId,
    },
    createdAt: workflow.createdAt,
  })
  let lease
  const transitions = []
  const context = Object.freeze({
    kind: 'long-form-index',
    projectId: workflow.projectId,
    workflowId: workflow.id,
    sourceArtifactId: workflow.sourceArtifactId,
    sourceManifestId: workflow.sourceManifestId,
  })
  const record = () => Object.freeze({ operation, context })
  const operations = {
    async claimNext(input) {
      if (
        input.type !== 'long-form-index' ||
        !['queued', 'retrying', 'running'].includes(operation.status)
      ) return null
      operation = startPublicOperationAttempt(operation, input.now)
      lease = {
        owner: input.leaseOwner,
        attempt: operation.attempt,
        heartbeatAt: input.now,
        expiresAt: input.leaseUntil,
      }
      return Object.freeze({ ...record(), lease })
    },
    async heartbeat(input) {
      return options.heartbeat === false
        ? false
        : operation.status === 'running' &&
          lease?.owner === input.leaseOwner &&
          lease.attempt === input.attempt
    },
    async advancePhase(input) {
      if (
        operation.status !== 'running' ||
        lease?.owner !== input.leaseOwner
      ) return false
      operation = advancePublicOperationPhase(
        operation,
        input.phase,
        input.now,
      )
      transitions.push(input.phase)
      return true
    },
    async succeed(input) {
      if (lease?.owner !== input.leaseOwner) return null
      operation = succeedPublicOperation(operation, input.now)
      lease = undefined
      return record()
    },
    async failOrRetry(input) {
      if (lease?.owner !== input.leaseOwner) return null
      operation = retryOrFailPublicOperation(
        operation,
        input.error,
        input.now,
        input.nextAttemptAt,
      )
      lease = undefined
      return record()
    },
  }
  const workflows = {
    async read() {
      return Object.freeze({
        workflow,
        operation,
        requestFingerprint: sha('request'),
        idempotencyKey: 'long-form-worker-request',
      })
    },
    async replaceWithLease(input) {
      if (
        lease?.owner !== input.leaseOwner ||
        lease.attempt !== input.operationAttempt ||
        workflow.runHash !== input.expectedRunHash
      ) return null
      workflow = input.nextWorkflow
      return workflow
    },
  }
  return {
    operations,
    workflows,
    transitions,
    getWorkflow: () => workflow,
    getOperation: () => operation,
  }
}

function advancingClock() {
  let milliseconds = Date.parse('2026-07-29T18:00:01.000Z')
  return () => {
    const value = new Date(milliseconds)
    milliseconds += 1_000
    return value
  }
}

test('F2.022 worker skips exact reuse, runs remaining stages and settles one durable operation', async () => {
  const fixture = workerFixture()
  const processed = []
  const run = runNextLongFormIndexOperationService({
    operations: fixture.operations,
    workflows: fixture.workflows,
    processor: {
      async process(input) {
        processed.push([
          input.checkpoint.stage,
          input.checkpoint.idempotencyKey,
          input.checkpoint.concurrency,
        ])
        assert.equal(input.signal.aborted, false)
        return {
          outputHash: sha(`output-${input.checkpoint.stage}`),
          resultCount:
            input.checkpoint.stage === 'moments' ? 24 : 120,
          costMinorUnits: 10,
          elapsedMs: 1000,
        }
      },
    },
    clock: advancingClock(),
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
  })
  const outcome = await run('worker-long-form-1')
  assert.deepEqual(outcome, {
    operationId: 'operation-long-form-worker',
    workflowId: 'workflow-long-form-worker',
    status: 'succeeded',
  })
  assert.deepEqual(
    processed.map(([stage]) => stage),
    ['diarization', 'chunks', 'moments'],
  )
  assert.deepEqual(fixture.transitions, [
    'diarizing',
    'chunking',
    'indexing',
    'persisting',
  ])
  assert.equal(fixture.getWorkflow().status, 'succeeded')
  assert.equal(fixture.getWorkflow().summary.costMinorUnits, 30)
  assert.equal(fixture.getOperation().status, 'succeeded')
})

test('F2.022 worker persists retryable stage failure before scheduling operation retry', async () => {
  const fixture = workerFixture()
  const run = runNextLongFormIndexOperationService({
    operations: fixture.operations,
    workflows: fixture.workflows,
    processor: {
      async process() {
        throw new Error('temporary provider failure')
      },
    },
    clock: advancingClock(),
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
  })
  const outcome = await run('worker-long-form-2')
  assert.equal(outcome.status, 'retrying')
  assert.equal(fixture.getOperation().status, 'retrying')
  const failed = fixture.getWorkflow().stages.find(
    (stage) => stage.stage === 'diarization',
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.retryable, true)
})

test('F2.022 interrupted stage is resumable with stable input and a new attempt', () => {
  const workflow = initialWorkflow()
  const started = startLongFormIndexStage({
    workflow,
    stage: 'diarization',
    expectedRunHash: workflow.runHash,
    startedAt: '2026-07-29T18:00:01.000Z',
  })
  const before = started.stages[2]
  const resumed = resumeLongFormIndexWorkflow({
    workflow: started,
    expectedRunHash: started.runHash,
    resumedAt: '2026-07-29T18:00:31.000Z',
  })
  const after = resumed.stages[2]
  assert.equal(after.status, 'ready')
  assert.equal(after.inputHash, before.inputHash)
  assert.equal(after.idempotencyKey, before.idempotencyKey)
  assert.equal(after.attempt, before.attempt)
})

test('F2.022 worker aborts without checkpoint promotion after lease loss', async () => {
  const fixture = workerFixture({ heartbeat: false })
  let signal
  const run = runNextLongFormIndexOperationService({
    operations: fixture.operations,
    workflows: fixture.workflows,
    processor: {
      async process(input) {
        signal = input.signal
        await input.heartbeat()
        return {
          outputHash: sha('stale-output'),
          resultCount: 1,
          costMinorUnits: 1,
          elapsedMs: 1,
        }
      },
    },
    clock: advancingClock(),
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
  })
  const outcome = await run('worker-long-form-3')
  assert.equal(outcome.status, 'lease-lost')
  assert.equal(signal.aborted, true)
  assert.equal(
    fixture.getWorkflow().stages[2].status,
    'running',
  )
  assert.equal(
    fixture.getWorkflow().stages[2].outputHash,
    undefined,
  )
})
