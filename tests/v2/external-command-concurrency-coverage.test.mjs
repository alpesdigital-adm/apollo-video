import assert from 'node:assert/strict'
import test from 'node:test'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'

const coverage = Object.freeze({
  'apollo.artifacts.reconstruction.preflight': {
    mode: 'read-only-deterministic', evidence: 'domain reconstruction preflight contracts',
  },
  'apollo.artifacts.rights.set': {
    mode: 'durable-covered', evidence: 'F0-072/F0-076',
  },
  'apollo.artifacts.materialization.authorize': {
    mode: 'durable-covered', evidence: 'F0-067',
  },
  'apollo.render-inputs.preflight': {
    mode: 'read-only-deterministic', evidence: 'domain RenderInput preflight contracts',
  },
  'apollo.artifacts.render.enqueue': {
    mode: 'durable-covered', evidence: 'F0-066',
  },
  'apollo.operations.cancel': {
    mode: 'durable-covered', evidence: 'F0-070',
  },
  'apollo.operations.retry': {
    mode: 'durable-covered', evidence: 'F0-070',
  },
  'apollo.webhooks.endpoints.create': {
    mode: 'durable-covered', evidence: 'F0-063',
  },
  'apollo.webhooks.endpoints.status.set': {
    mode: 'durable-covered', evidence: 'F0-071',
  },
  'apollo.webhooks.endpoints.challenge': {
    mode: 'durable-covered', evidence: 'F0-075',
  },
  'apollo.webhooks.endpoints.signing-secrets.provision': {
    mode: 'durable-covered', evidence: 'F0-065',
  },
  'apollo.webhooks.endpoints.signing-secrets.rotations.stage': {
    mode: 'durable-covered', evidence: 'F0-059',
  },
  'apollo.webhooks.endpoints.signing-secrets.rotations.activate': {
    mode: 'durable-covered', evidence: 'F0-059',
  },
  'apollo.webhooks.endpoints.signing-secrets.rotations.cancel': {
    mode: 'durable-covered', evidence: 'F0-059',
  },
  'apollo.webhooks.signing-secrets.hygiene.run': {
    mode: 'durable-covered', evidence: 'F0-059',
  },
  'apollo.webhooks.subscriptions.create': {
    mode: 'durable-covered', evidence: 'F0-064',
  },
  'apollo.webhooks.subscriptions.status.set': {
    mode: 'durable-covered', evidence: 'F0-071',
  },
  'apollo.webhooks.deliveries.replay': {
    mode: 'durable-covered', evidence: 'F0-068',
  },
  'apollo.webhooks.events.replay': {
    mode: 'durable-covered', evidence: 'F0-069',
  },
  'apollo.projects.create': {
    mode: 'durable-covered', evidence: 'F0-060',
  },
  'apollo.media.uploads.begin': {
    mode: 'durable-covered', evidence: 'F0-086',
  },
  'apollo.clients.create': {
    mode: 'durable-covered', evidence: 'F0-061',
  },
  'apollo.clients.credentials.rotate': {
    mode: 'durable-covered', evidence: 'F0-062',
  },
  'apollo.clients.credentials.revoke': {
    mode: 'durable-covered', evidence: 'F0-073',
  },
})

const externalCommands = FOUNDATION_CAPABILITIES.filter(
  (capability) =>
    capability.exposure !== 'internal-only' && capability.operationKind !== 'query',
)

test('every external non-query capability has an explicit concurrency classification', () => {
  assert.deepEqual(
    Object.keys(coverage).sort(),
    externalCommands.map((capability) => capability.id).sort(),
  )
  for (const capability of externalCommands) {
    const entry = coverage[capability.id]
    assert.ok(entry.evidence.trim().length > 0, `${capability.id} must cite evidence`)
    assert.notEqual(capability.idempotency, 'not-applicable')
    if (entry.mode === 'read-only-deterministic') {
      assert.equal(capability.operationKind, 'preflight')
    }
  }
})

test('the concurrency audit has no unclassified durable gap', () => {
  const pending = Object.entries(coverage)
    .filter(([, entry]) => entry.mode === 'pending-concurrency')
    .map(([capabilityId]) => capabilityId)
  assert.deepEqual(pending, [])
  assert.equal(
    Object.values(coverage).filter((entry) => entry.mode === 'durable-covered').length,
    22,
  )
  assert.equal(
    Object.values(coverage).filter((entry) => entry.mode === 'read-only-deterministic').length,
    2,
  )
})
