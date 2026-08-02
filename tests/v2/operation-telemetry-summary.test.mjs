import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeOperationTelemetryService } from '../../src/v2/application/summarize-operation-telemetry.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

test('operation telemetry summary defaults to a bounded workspace window', async () => {
  const calls = []
  const expected = Object.freeze({ from: '2026-08-01T12:00:00.000Z', to: '2026-08-02T12:00:00.000Z' })
  const summarize = summarizeOperationTelemetryService({
    now: () => new Date(expected.to),
    telemetry: { async summarize(input) { calls.push(input); return expected } },
  })
  assert.equal(await summarize({ workspaceId: 'workspace-telemetry' }), expected)
  assert.deepEqual(calls, [{ workspaceId: 'workspace-telemetry', ...expected }])
})

test('operation telemetry summary rejects malformed, future and oversized windows', async () => {
  const summarize = summarizeOperationTelemetryService({
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    telemetry: { async summarize() { throw new Error('must not query') } },
  })
  await assert.rejects(summarize({ workspaceId: 'workspace-telemetry', from: 'bad' }), /ISO 8601/)
  await assert.rejects(summarize({ workspaceId: 'workspace-telemetry', from: '2026-06-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }), /31 days/)
  await assert.rejects(summarize({ workspaceId: 'workspace-telemetry', from: '2026-08-02T11:00:00.000Z', to: '2026-08-02T12:02:00.000Z' }), /future/)
  await assert.rejects(summarize({ workspaceId: 'x' }), /workspaceId/)
})

test('telemetry summary is public API-first with operations read scope and a closed schema', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.operations.telemetry.summary')
  assert.equal(capability.endpoint.path, '/v1/operations/telemetry/summary')
  assert.deepEqual(capability.requiredScopes, ['operations:read'])
  const schema = getPublicSchema(capability.outputSchemaRef).schema
  assert.equal(schema.properties.data.additionalProperties, false)
  assert.deepEqual(schema.properties.data.required, ['from', 'to', 'events', 'alerts', 'metrics'])
})
