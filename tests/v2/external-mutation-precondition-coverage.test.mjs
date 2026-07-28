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
  'apollo.batches.create': {
    mode: 'idempotent-create',
    evidence: 'F2-007 request fingerprint binds the project, sources, recipes, variants, budget and complete explicit item set; serializable persistence rechecks project, artifacts, rights and actor',
  },
  'apollo.batches.actions.apply': {
    mode: 'production-batch-revision-action',
    evidence: 'F2-007 request requires expectedBatchRevision; the serializable repository compares and swaps the batch revision before cancel or resume and records one actor-bound idempotent result',
  },
  'apollo.batches.items.actions.apply': {
    mode: 'production-batch-revision-action',
    itemRevision: true,
    evidence: 'F2-007 request requires expectedBatchRevision and expectedItemRevision; the serializable repository compares both before transitioning only the selected item and step',
  },
  'apollo.batches.script-alignments.create': {
    mode: 'idempotent-create',
    evidence: 'F2-008 request fingerprint binds the exact script, ordered source transcript IDs and hashes, optional role hints and actor; serializable persistence rechecks batch membership, artifacts, rights, consent and canonical transcript hashes',
  },
  'apollo.batches.script-alignments.reviews.apply': {
    mode: 'script-alignment-revision-action',
    evidence: 'F2-008 request requires expectedRevision; serializable persistence compares and swaps the exact alignment revision before storing one immutable review and replay snapshot',
  },
  'apollo.batches.take-libraries.create': {
    mode: 'idempotent-create',
    evidence: 'F2-009 request fingerprint binds the exact alignment ID/hash, every measured source hash and evaluation, inferred intention evidence and actor; serializable persistence rechecks the immutable alignment and source evidence',
  },
  'apollo.batches.take-libraries.selections.apply': {
    mode: 'take-library-revision-action',
    evidence: 'F2-009 request requires expectedRevision; serializable persistence compares and swaps the exact take-library revision before recording a source-preserving selection and protected-take decision',
  },
  'apollo.batches.compatibility-graphs.create': {
    mode: 'idempotent-create',
    evidence: 'F2-010 request fingerprint binds the exact take-library ID/hash, every eligible take hash, compatibility context, thresholds and actor; serializable persistence rechecks library, batch and actor before writing one immutable graph',
  },
  'apollo.batches.variant-recipes.create': {
    mode: 'idempotent-create',
    evidence: 'F2-011 request fingerprint binds the exact compatibility graph ID/hash, ordered node selection, proof policy, assumptions, optional cold open and actor; serializable persistence rechecks batch objective, graph hash/context and actor before writing recipe plus lineage',
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
  'apollo.projects.duplicates.create': {
    mode: 'idempotent-create', evidence: 'request additionally binds the source current version and hash; serializable persistence rechecks the source snapshots and media before creating the copy-on-write fork',
  },
  'apollo.projects.mvp-core-gates.run': {
    mode: 'idempotent-create', evidence: 'request additionally binds both current project versions and hashes; the server derives all 50 checks from PostgreSQL and rechecks both versions before serializable persistence',
  },
  'apollo.projects.speech-segments.catalog': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the exact transcript ID/hash, extraction policy, producer and annotations; serializable persistence rechecks transcript, artifact and actor before activating the immutable run',
  },
  'apollo.projects.evidence-segments.catalog': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the exact SpeechSegment ID/hash, claim/context metadata and current rights/consent snapshot; serializable persistence rechecks source, rights, artifact and actor',
  },
  'apollo.projects.long-form-moments.catalog': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the exact video artifact/hash, manifest/hash, hierarchy, producer and actor; serializable persistence rechecks project membership, manifest, duration, rights and actor before activating the immutable index',
  },
  'apollo.projects.validated-segments.catalog': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds exact artifact/manifest/SpeechSegment hashes, scope, performance source and actor; serializable persistence rechecks project membership, active source, rights and actor',
  },
  'apollo.projects.semantic-search.documents.catalog': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the exact source identity/hash, index version, observations, embedding input and actor; serializable persistence rechecks source, project membership, current rights and actor before replacing the active identity',
  },
  'apollo.projects.semantic-search.evaluations.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds k, all query cases, relevance judgments and actor; every case executes the same public search service and one immutable report is persisted transactionally',
  },
  'apollo.projects.hierarchical-processing.runs.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds exact artifact, manifest, transcript, chunk policy, tier versions, prior run hash, budget and actor; serializable persistence rechecks every source and rights identity before replacing the active run',
  },
  'apollo.projects.annotations.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the current ProjectVersion, proxy artifact and proxy hash',
  },
  'apollo.projects.review-patches.propose': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the annotation and its immutable base ProjectVersion',
  },
  'apollo.projects.review-patches.apply': {
    mode: 'idempotent-create', evidence: 'persisted proposal binds the immutable base and one transactional result version; request key replays it',
  },
  'apollo.projects.review-patch-batches.propose': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the ordered ready proposals, current immutable version and EditPlan',
  },
  'apollo.projects.review-patch-batches.apply': {
    mode: 'idempotent-create', evidence: 'confirmed batch binds one immutable base and one transactional result version; request key replays it',
  },
  'apollo.projects.commands.apply': {
    mode: 'base-version-bound-action', evidence: 'request binds immutable baseVersionId and baseHash before transactional mutation',
  },
  'apollo.projects.manual-edits.apply': {
    mode: 'base-version-bound-action', evidence: 'request binds immutable baseVersionId, baseHash and expectedRevision before the serializable manual-edit transaction',
  },
  'apollo.projects.version-comparisons.act': {
    mode: 'base-version-bound-action', evidence: 'request binds immutable before/after versions plus current baseVersionId, baseHash and expectedRevision before accept, reopen or restore',
  },
  'apollo.projects.proxy-renders.enqueue': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds current immutable ProjectVersion, EditPlan and source artifact identity',
  },
  'apollo.projects.proxy-reviews.acknowledge-warnings': {
    mode: 'explicit-precondition', mechanism: 'body-revision', evidence: 'request binds proxyReviewId, projectVersionId, baseRevision review hash and expectedRevision; hard issues are never acknowledgeable',
  },
  'apollo.projects.asset-selections.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds projectVersionId/projectVersionHash and the serializable commit rechecks current version, artifacts and rights snapshots',
  },
  'apollo.projects.quality-iterations.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds project version, proxy revision/hash, asset selections, rubric evidence, reference dataset and fixed budget; serializable commit rechecks all server evidence',
  },
  'apollo.projects.final-exports.enqueue': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds explicit approval, current immutable ProjectVersion, EditPlan, DirectorRun, QualitySnapshot and source artifact identity',
  },
  'apollo.media.uploads.begin': {
    mode: 'idempotent-create', evidence: 'F0-086',
  },
  'apollo.media.uploads.session.issue': {
    mode: 'state-machine-action', evidence: 'F0-087',
  },
  'apollo.media.uploads.parts.record': { mode: 'state-machine-action', evidence: 'F0-088' },
  'apollo.media.uploads.complete': { mode: 'state-machine-action', evidence: 'F0-088' },
  'apollo.media.uploads.abort': { mode: 'state-machine-action', evidence: 'bounded media upload lifecycle transition' },
  'apollo.media.uploads.content.put': { mode: 'explicit-precondition', mechanism: 'signed-intent', evidence: 'signed token binds upload, session mode, checksum and expiry' },
  'apollo.artifacts.download-grants.issue': { mode: 'idempotent-create', evidence: 'F0-089' },
  'apollo.artifacts.download-grants.revoke': { mode: 'state-machine-action', evidence: 'F0-089' },
  'apollo.clients.create': {
    mode: 'idempotent-create', evidence: 'F0-061',
  },
  'apollo.clients.credentials.rotate': {
    mode: 'idempotent-create', evidence: 'F0-062',
  },
  'apollo.clients.credentials.revoke': {
    mode: 'state-machine-action', evidence: 'F0-073',
  },
  'apollo.sessions.login': { mode: 'state-machine-action', evidence: 'credential verification creates a bounded server-signed session' },
  'apollo.sessions.logout': { mode: 'state-machine-action', evidence: 'session revocation is naturally idempotent' },
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

function requiresImmutableBase(capability) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  assert.ok(schema.required?.includes('baseVersionId'), `${capability.id} must require baseVersionId`)
  assert.ok(schema.required?.includes('baseHash'), `${capability.id} must require baseHash`)
  assert.ok(schema.properties?.baseVersionId, `${capability.id} must define baseVersionId`)
  assert.ok(schema.properties?.baseHash, `${capability.id} must define baseHash`)
}

function requiresProductionBatchRevision(capability, itemRevision) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  assert.ok(
    schema.required?.includes('expectedBatchRevision'),
    `${capability.id} must require expectedBatchRevision`,
  )
  assert.ok(
    schema.properties?.expectedBatchRevision,
    `${capability.id} must define expectedBatchRevision`,
  )
  if (itemRevision) {
    assert.ok(
      schema.required?.includes('expectedItemRevision'),
      `${capability.id} must require expectedItemRevision`,
    )
    assert.ok(
      schema.properties?.expectedItemRevision,
      `${capability.id} must define expectedItemRevision`,
    )
  }
}

function requiresScriptAlignmentRevision(capability) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  assert.ok(
    schema.required?.includes('expectedRevision'),
    `${capability.id} must require expectedRevision`,
  )
  assert.ok(
    schema.properties?.expectedRevision,
    `${capability.id} must define expectedRevision`,
  )
}

function requiresTakeLibraryRevision(capability) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  assert.ok(
    schema.required?.includes('expectedRevision'),
    `${capability.id} must require expectedRevision`,
  )
  assert.ok(
    schema.properties?.expectedRevision,
    `${capability.id} must define expectedRevision`,
  )
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
      } else if (decision.mechanism === 'signed-intent') {
        assert.equal(capability.precondition, 'signed-intent')
      } else {
        assert.equal(decision.mechanism, 'body-revision')
        requiresBodyRevision(capability)
      }
    }

    if (decision.mode === 'revision-bound-action') {
      requiresBodyRevision(capability)
    }
    if (decision.mode === 'base-version-bound-action') {
      requiresImmutableBase(capability)
      assert.equal(capability.idempotency, 'required')
    }
    if (decision.mode === 'production-batch-revision-action') {
      requiresProductionBatchRevision(capability, decision.itemRevision === true)
      assert.equal(capability.idempotency, 'required')
    }
    if (decision.mode === 'script-alignment-revision-action') {
      requiresScriptAlignmentRevision(capability)
      assert.equal(capability.idempotency, 'required')
    }
    if (decision.mode === 'take-library-revision-action') {
      requiresTakeLibraryRevision(capability)
      assert.equal(capability.idempotency, 'required')
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
    'explicit-precondition': 5,
    'idempotent-create': 32,
    'state-machine-action': 13,
    'single-flight-action': 1,
    'revision-bound-action': 4,
    'base-version-bound-action': 3,
    'production-batch-revision-action': 2,
    'script-alignment-revision-action': 1,
    'take-library-revision-action': 1,
  })
})
