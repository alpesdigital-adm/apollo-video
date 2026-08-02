import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import {
  createPublicOperationTelemetryEvent,
  publicOperationTraceId,
} from '../../src/v2/application/public-operation-telemetry.ts'
import { TelemetryPublicOperationRepository } from '../../src/v2/infrastructure/telemetry-public-operation-repository.ts'
import { StructuredConsoleOperationTelemetry } from '../../src/v2/infrastructure/structured-console-operation-telemetry.ts'

const context = Object.freeze({
  kind: 'media-ingest',
  uploadId: 'upload-telemetry-test',
  projectId: 'project-telemetry-test',
  originalFileName: 'private-interview.mp4',
  sourceArtifactId: 'artifact-source-telemetry',
  sourceManifestId: 'manifest-source-telemetry',
})

function queuedOperation() {
  return createQueuedPublicOperation({
    id: 'operation-telemetry-test',
    workspaceId: 'workspace-telemetry-test',
    clientId: 'client-telemetry-test',
    type: 'media-ingest',
    target: {
      type: 'media-artifact',
      id: 'artifact-target-telemetry',
      manifestId: 'manifest-target-telemetry',
    },
    createdAt: '2026-08-02T17:00:00.000Z',
  })
}

test('public operation telemetry carries canonical identifiers and no operation context data', () => {
  const operation = queuedOperation()
  const event = createPublicOperationTelemetryEvent({
    event: 'operation.created',
    record: { operation, context },
  })

  assert.deepEqual(event, {
    schemaVersion: 'public-operation-telemetry/v1',
    event: 'operation.created',
    occurredAt: '2026-08-02T17:00:00.000Z',
    traceId: publicOperationTraceId({
      workspaceId: operation.workspaceId,
      operationId: operation.id,
    }),
    jobId: operation.id,
    workspaceId: operation.workspaceId,
    projectId: context.projectId,
    operationType: 'media-ingest',
    status: 'queued',
    phase: 'queued',
    attempt: 0,
  })
  assert.equal(Object.isFrozen(event), true)
  const serialized = JSON.stringify(event)
  assert.equal(serialized.includes(context.originalFileName), false)
  assert.equal(serialized.includes(context.uploadId), false)
  assert.equal(serialized.includes(context.sourceArtifactId), false)
})

test('persisted request trace overrides the deterministic fallback across processes', () => {
  const event = createPublicOperationTelemetryEvent({
    event: 'operation.claimed',
    record: {
      operation: queuedOperation(),
      context,
      traceId: 'request_trace_telemetry_001',
    },
  })

  assert.equal(event.traceId, 'request_trace_telemetry_001')
})

test('telemetry repository emits the durable worker lifecycle with one stable trace', async () => {
  let operation = queuedOperation()
  let lease
  const record = () => ({
    operation,
    context,
    traceId: 'request_trace_worker_lifecycle_001',
  })
  const repository = {
    async claimNext(input) {
      operation = startPublicOperationAttempt(operation, input.now)
      lease = Object.freeze({
        owner: input.leaseOwner,
        attempt: operation.attempt,
        heartbeatAt: input.now,
        expiresAt: input.leaseUntil,
      })
      return { ...record(), lease }
    },
    async heartbeat() { return true },
    async advancePhase(input) {
      operation = advancePublicOperationPhase(operation, input.phase, input.now)
      return true
    },
    async succeed(input) {
      operation = succeedPublicOperation(operation, input.now)
      return record()
    },
  }
  const events = []
  const decorated = new TelemetryPublicOperationRepository(repository, {
    emit(event) { events.push(event) },
  })
  const leaseCommand = {
    operationId: operation.id,
    leaseOwner: 'worker-telemetry-test',
    attempt: 1,
  }

  await decorated.claimNext({
    leaseOwner: leaseCommand.leaseOwner,
    now: '2026-08-02T17:00:01.000Z',
    leaseUntil: '2026-08-02T17:01:01.000Z',
    type: 'media-ingest',
  })
  await decorated.heartbeat({
    ...leaseCommand,
    now: '2026-08-02T17:00:02.000Z',
    leaseUntil: '2026-08-02T17:01:02.000Z',
  })
  for (const [index, phase] of [
    'probing',
    'normalizing',
    'transcribing',
    'verifying',
    'persisting',
  ].entries()) {
    await decorated.advancePhase({
      ...leaseCommand,
      now: `2026-08-02T17:00:0${index + 3}.000Z`,
      phase,
    })
  }
  await decorated.succeed({
    ...leaseCommand,
    now: '2026-08-02T17:00:09.000Z',
  })

  assert.deepEqual(events.map((event) => event.event), [
    'operation.claimed',
    'operation.heartbeat',
    'operation.phase-advanced',
    'operation.phase-advanced',
    'operation.phase-advanced',
    'operation.phase-advanced',
    'operation.phase-advanced',
    'operation.succeeded',
  ])
  assert.equal(new Set(events.map((event) => event.traceId)).size, 1)
  assert.equal(events[0].traceId, 'request_trace_worker_lifecycle_001')
  assert.equal(events.every((event) => event.jobId === operation.id), true)
  assert.equal(events.at(-1).status, 'succeeded')
  assert.equal(events.at(-1).phase, 'completed')
})

test('telemetry failures never change durable repository results', async () => {
  const operation = queuedOperation()
  const persisted = { operation, context, replayed: false }
  const decorated = new TelemetryPublicOperationRepository({
    async createOrReplay() { return persisted },
  }, {
    async emit() { throw new Error('collector unavailable') },
  })

  assert.equal(await decorated.createOrReplay({}), persisted)

  const fallback = []
  const telemetry = new StructuredConsoleOperationTelemetry({
    info() { throw new Error('stdout unavailable') },
    error(message) { fallback.push(JSON.parse(message)) },
  })
  telemetry.emit(createPublicOperationTelemetryEvent({
    event: 'operation.created',
    record: persisted,
  }))
  assert.deepEqual(fallback.map((entry) => entry.event), [
    'operation.telemetry-failed',
  ])
})

test('lost leases evict cached job context before any later lifecycle event', async () => {
  let operation = queuedOperation()
  const events = []
  const decorated = new TelemetryPublicOperationRepository({
    async claimNext(input) {
      operation = startPublicOperationAttempt(operation, input.now)
      return {
        operation,
        context,
        lease: {
          owner: input.leaseOwner,
          attempt: operation.attempt,
          heartbeatAt: input.now,
          expiresAt: input.leaseUntil,
        },
      }
    },
    async heartbeat() { return false },
    async advancePhase() { return true },
  }, {
    emit(event) { events.push(event) },
  })
  const lease = {
    operationId: operation.id,
    leaseOwner: 'worker-lost-lease',
    attempt: 1,
  }

  await decorated.claimNext({
    leaseOwner: lease.leaseOwner,
    now: '2026-08-02T17:00:01.000Z',
    leaseUntil: '2026-08-02T17:01:01.000Z',
  })
  assert.equal(await decorated.heartbeat({
    ...lease,
    now: '2026-08-02T17:00:02.000Z',
    leaseUntil: '2026-08-02T17:01:02.000Z',
  }), false)
  assert.equal(await decorated.advancePhase({
    ...lease,
    now: '2026-08-02T17:00:03.000Z',
    phase: 'probing',
  }), true)

  assert.deepEqual(events.map((event) => event.event), ['operation.claimed'])
})
