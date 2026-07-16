import assert from 'node:assert/strict'
import test from 'node:test'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const coverage = Object.freeze({
  'apollo.artifacts.reconstruction.preflight': {
    mode: 'read-only-preflight', evidence: 'deterministic reconstruction preflight',
  },
  'apollo.artifacts.rights.set': {
    mode: 'explicit-precondition', mechanism: 'if-match', evidence: 'F0-076',
  },
  'apollo.artifacts.materialization.authorize': {
    mode: 'idempotent-create', evidence: 'F0-067',
  },
  'apollo.render-inputs.preflight': {
    mode: 'read-only-preflight', evidence: 'deterministic RenderInput preflight',
  },
  'apollo.artifacts.render.enqueue': {
    mode: 'idempotent-create', evidence: 'F0-066',
  },
  'apollo.operations.cancel': {
    mode: 'state-machine-action', evidence: 'F0-070',
  },
  'apollo.operations.retry': {
    mode: 'state-machine-action', evidence: 'F0-070',
  },
  'apollo.webhooks.endpoints.create': {
    mode: 'idempotent-create', evidence: 'F0-063',
  },
  'apollo.webhooks.endpoints.status.set': {
    mode: 'explicit-precondition', mechanism: 'body-revision', evidence: 'F0-071',
  },
  'apollo.webhooks.endpoints.challenge': {
    mode: 'single-flight-action', evidence: 'F0-075',
  },
  'apollo.webhooks.endpoints.signing-secrets.provision': {
    mode: 'revision-bound-action', evidence: 'F0-065',
  },
  'apollo.webhooks.endpoints.signing-secrets.rotations.stage': {
    mode: 'revision-bound-action', evidence: 'F0-059',
  },
  'apollo.webhooks.endpoints.signing-secrets.rotations.activate': {
    mode: 'revision-bound-action', evidence: 'F0-059',
  },
  'apollo.webhooks.endpoints.signing-secrets.rotations.cancel': {
    mode: 'revision-bound-action', evidence: 'F0-059',
  },
  'apollo.webhooks.signing-secrets.hygiene.run': {
    mode: 'state-machine-action', evidence: 'F0-059',
  },
  'apollo.webhooks.subscriptions.create': {
    mode: 'idempotent-create', evidence: 'F0-064',
  },
  'apollo.webhooks.subscriptions.status.set': {
    mode: 'explicit-precondition', mechanism: 'body-revision', evidence: 'F0-071',
  },
  'apollo.webhooks.deliveries.replay': {
    mode: 'state-machine-action', evidence: 'F0-068',
  },
  'apollo.webhooks.events.replay': {
    mode: 'state-machine-action', evidence: 'F0-069',
  },
  'apollo.projects.create': {
    mode: 'idempotent-create', evidence: 'F0-060',
  },
  'apollo.media.uploads.begin': {
    mode: 'idempotent-create', evidence: 'F0-086',
  },
  'apollo.media.uploads.session.issue': {
    mode: 'state-machine-action', evidence: 'F0-087',
  },
  'apollo.clients.create': {
    mode: 'idempotent-create', evidence: 'F0-061',
  },
  'apollo.clients.credentials.rotate': {
    mode: 'idempotent-create', evidence: 'F0-062',
  },
  'apollo.clients.credentials.revoke': {
    mode: 'state-machine-action', evidence: 'F0-073',
  },
})

const externalMutations = FOUNDATION_CAPABILITIES.filter(
  (capability) =>
    capability.exposure !== 'internal-only' && capability.operationKind !== 'query',
)

function requiresBodyRevision(capability) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  assert.ok(schema.required?.includes('baseRevision'), `${capability.id} must require baseRevision`)
  assert.ok(schema.properties?.baseRevision, `${capability.id} must define baseRevision`)
}

test('every external mutation has an explicit precondition strategy', () => {
  assert.deepEqual(
    Object.keys(coverage).sort(),
    externalMutations.map((capability) => capability.id).sort(),
  )

  for (const capability of externalMutations) {
    const decision = coverage[capability.id]
    assert.ok(decision.evidence.trim().length > 0, `${capability.id} must cite evidence`)

    if (capability.endpoint?.method === 'PUT' || capability.endpoint?.method === 'PATCH') {
      assert.equal(
        decision.mode,
        'explicit-precondition',
        `${capability.id} replaces state and must reject stale bases`,
      )
    }

    if (decision.mode === 'explicit-precondition') {
      if (decision.mechanism === 'if-match') {
        assert.equal(capability.precondition, 'if-match')
        assert.equal(capability.responseEtag, true)
      } else {
        assert.equal(decision.mechanism, 'body-revision')
        requiresBodyRevision(capability)
      }
    }

    if (decision.mode === 'revision-bound-action') {
      requiresBodyRevision(capability)
    }
    if (decision.mode === 'idempotent-create') {
      assert.equal(capability.idempotency, 'required')
    }
    if (decision.mode === 'read-only-preflight') {
      assert.equal(capability.operationKind, 'preflight')
    }
    if (decision.mode === 'single-flight-action') {
      assert.equal(capability.idempotency, 'natural')
    }
  }
})

test('the current public surface has no unguarded state replacement', () => {
  const counts = Object.values(coverage).reduce((result, decision) => {
    result[decision.mode] = (result[decision.mode] ?? 0) + 1
    return result
  }, {})
  assert.deepEqual(counts, {
    'read-only-preflight': 2,
    'explicit-precondition': 3,
    'idempotent-create': 8,
    'state-machine-action': 7,
    'single-flight-action': 1,
    'revision-bound-action': 4,
  })
})
