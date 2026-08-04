import assert from 'node:assert/strict'
import test from 'node:test'

import { createQueuedPublicOperation } from '../../src/v2/domain/public-operation.ts'
import { runPublicOperationSpan } from '../../src/v2/application/public-operation-span-telemetry.ts'

function record() {
  return {
    operation: createQueuedPublicOperation({
      id: 'operation-span-test',
      workspaceId: 'workspace-span-test',
      projectId: 'project-span-test',
      clientId: 'client-span-test',
      type: 'project-proxy-render',
      target: {
        type: 'media-artifact',
        id: 'artifact-span-test',
        manifestId: 'manifest-span-test',
      },
      createdAt: '2026-08-02T19:00:00.000Z',
    }),
    context: {
      kind: 'project-proxy-render',
      projectId: 'project-span-test',
    },
    traceId: 'request_trace_span_test_001',
    lease: {
      owner: 'worker-span-test',
      attempt: 2,
      heartbeatAt: '2026-08-02T19:00:01.000Z',
      expiresAt: '2026-08-02T19:01:01.000Z',
    },
  }
}

function clock(...values) {
  let index = 0
  return () => new Date(values[Math.min(index++, values.length - 1)])
}

test('provider and renderer span carries only durable identifiers and duration', async () => {
  const events = []
  const result = await runPublicOperationSpan({
    telemetry: { emit(event) { events.push(event) } },
    record: record(),
    spanKind: 'renderer',
    spanName: 'ffmpeg-editorial-proxy',
    clock: clock(
      '2026-08-02T19:00:02.000Z',
      '2026-08-02T19:00:03.250Z',
    ),
    action: async () => 'rendered',
    metrics: () => ({ inputBytes: 2048, outputBytes: 1024, costMinorUnits: 7 }),
  })

  assert.equal(result, 'rendered')
  assert.deepEqual(events.map((event) => event.event), [
    'operation.span-started',
    'operation.span-succeeded',
  ])
  assert.equal(events[1].durationMs, 1_250)
  assert.deepEqual(
    { inputBytes: events[1].inputBytes, outputBytes: events[1].outputBytes, costMinorUnits: events[1].costMinorUnits },
    { inputBytes: 2048, outputBytes: 1024, costMinorUnits: 7 },
  )
  assert.equal(events[0].traceId, 'request_trace_span_test_001')
  assert.equal(events[0].jobId, 'operation-span-test')
  assert.equal(events[0].workspaceId, 'workspace-span-test')
  assert.equal(events[0].projectId, 'project-span-test')
  assert.equal(events[0].attempt, 2)
  assert.equal(JSON.stringify(events).includes('artifact-span-test'), false)
  assert.equal(Object.isFrozen(events[0]), true)
})

test('span metric allowlist drops invalid values and never inspects provider payloads', async () => {
  const events = []
  const result = { secret: 'provider-payload', tokens: 12 }
  assert.equal(await runPublicOperationSpan({
    telemetry: { emit(event) { events.push(event) } }, record: record(),
    spanKind: 'provider', spanName: 'groq-transcription',
    action: async () => result,
    metrics: () => ({ inputTokens: 12, outputTokens: -1, outputBytes: Number.NaN }),
  }), result)
  assert.equal(events.at(-1).inputTokens, 12)
  assert.equal('outputTokens' in events.at(-1), false)
  assert.equal(JSON.stringify(events).includes('provider-payload'), false)
})

test('failed span preserves the provider error and telemetry failures are isolated', async () => {
  const expected = new Error('provider unavailable')
  const events = []
  await assert.rejects(
    runPublicOperationSpan({
      telemetry: { emit(event) { events.push(event) } },
      record: record(),
      spanKind: 'provider',
      spanName: 'groq-transcription',
      clock: clock(
        '2026-08-02T19:00:04.000Z',
        '2026-08-02T19:00:04.500Z',
      ),
      action: async () => { throw expected },
    }),
    (error) => error === expected,
  )
  assert.equal(events.at(-1).event, 'operation.span-failed')
  assert.equal(events.at(-1).durationMs, 500)

  assert.equal(await runPublicOperationSpan({
    telemetry: { emit() { throw new Error('collector unavailable') } },
    record: record(),
    spanKind: 'provider',
    spanName: 'groq-transcription',
    action: async () => 'provider-result',
  }), 'provider-result')
})
