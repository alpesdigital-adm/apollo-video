import assert from 'node:assert/strict'
import test from 'node:test'

import { createPreflightResult } from '../../src/v2/domain/preflight-result.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'

const base = {
  schemaVersion: 'preflight-result/v1', eligible: true, fingerprint: 'a'.repeat(64), evaluatedAt: '2026-07-16T23:30:00.000Z',
  targets: [{ kind: 'project-version', id: 'version-2' }], conflicts: [],
  invalidations: [{ kind: 'render', id: 'render-old', reason: 'Timeline changed' }],
  jobs: [{ kind: 'render-proxy', count: 2, estimatedDurationMs: 1000 }],
  cost: { currency: 'USD', estimatedMinorUnits: 10, maximumMinorUnits: 15 },
  quota: { unit: 'render-minute', required: 2, remaining: 10, allowed: true },
  warnings: [{ code: 'REFLOW', message: 'Captions may reflow' }],
}

test('canonical PreflightResult carries every decision dimension and is immutable', () => {
  const result = createPreflightResult(base)
  assert.equal(result.eligible, true)
  for (const key of ['targets', 'conflicts', 'invalidations', 'jobs', 'cost', 'quota', 'warnings']) assert.ok(key in result)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.targets), true)
})

test('conflicts, quota and monetary bounds fail closed when inconsistent', () => {
  assert.throws(() => createPreflightResult({ ...base, conflicts: [{ code: 'STALE', target: 'version-2', message: 'Version changed' }] }), /eligibility/)
  assert.throws(() => createPreflightResult({ ...base, quota: { ...base.quota, remaining: 1, allowed: true } }), /quota/)
  assert.throws(() => createPreflightResult({ ...base, cost: { ...base.cost, maximumMinorUnits: 5 } }), /cost/)
})

test('PreflightResult v1 is externally discoverable through the schema API contract', () => {
  const schema = getPublicSchema('apollo://schemas/preflight-result/v1')
  assert.equal(schema.id, 'preflight-result')
  assert.equal(schema.version, 1)
  assert.equal(publicSchemaExamples(schema).length, 1)
  assert.deepEqual(schema.schema.required, ['schemaVersion', 'eligible', 'fingerprint', 'evaluatedAt', 'targets', 'conflicts', 'invalidations', 'jobs', 'cost', 'quota', 'warnings'])
})
