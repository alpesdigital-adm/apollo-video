import assert from 'node:assert/strict'
import test from 'node:test'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const coverage = Object.freeze({
  'apollo.director-tools.execute': {
    mode: 'revision-bound-action',
    evidence: 'Wave7 requires baseRevision for the durable Director run budget and atomically reserves before any paid application handler',
  },
  'apollo.api-access.workspace.change': {
    mode: 'explicit-precondition', mechanism: 'body-revision',
    evidence: 'F0.036 requires the exact workspace API access revision and applies the transition, audit row and eligible operation cancellations in one serializable transaction',
  },
  'apollo.api-access.clients.change': {
    mode: 'explicit-precondition', mechanism: 'body-revision',
    evidence: 'F0.036 requires the exact client API access revision and applies the transition, audit row and eligible operation cancellations in one serializable transaction',
  },
  'apollo.artifacts.reconstruction.preflight': {
    mode: 'read-only-preflight', evidence: 'deterministic reconstruction preflight',
  },
  'apollo.artifacts.rights.set': {
    mode: 'explicit-precondition', mechanism: 'if-match', evidence: 'F0-076',
  },
  'apollo.artifacts.lifecycle.transition': {
    mode: 'revision-bound-action',
    evidence: 'F0.029 requires baseRevision; serializable persistence fences workspace, current status and lifecycle revision before writing immutable audit history',
  },
  'apollo.artifacts.materialization.authorize': {
    mode: 'idempotent-create', evidence: 'F0-067',
  },
  'apollo.render-inputs.preflight': {
    mode: 'read-only-preflight', evidence: 'deterministic RenderInput preflight',
  },
  'apollo.editorial-grammar.evaluate': {
    mode: 'read-only-preflight', evidence: 'deterministic content-addressed editorial grammar evaluation with no persistence',
  },
  'apollo.responsive-placement.solve': {
    mode: 'read-only-preflight', evidence: 'deterministic content-addressed format-specific placement evaluation with no persistence',
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
  'apollo.batches.variant-portfolio-preflights.create': {
    mode: 'idempotent-create',
    evidence: 'F2-012 request fingerprint binds the exact graph ID/hash, requested top-N, proof policy and actor; signed expansion confirmation also binds the graph snapshot, workspace policy, batch output matrix and remaining budget before serializable no-job persistence',
  },
  'apollo.batches.edit-preflights.create': {
    mode: 'idempotent-create',
    evidence: 'F2-013 request fingerprint binds expected batch revision/hash, exact recipe/format/item IDs, typed operation, mode and actor before serializable immutable preview persistence',
  },
  'apollo.batches.edit-preflights.commit': {
    mode: 'batch-edit-signed-action',
    evidence: 'F2-013 requires exact preflight and scope hashes plus a short-lived actor/workspace/request/scope/cost-bound token; serializable commit rechecks batch, latest item states, policy and remaining budget',
  },
  'apollo.batches.partial-retries.create': {
    mode: 'batch-partial-retry-action',
    evidence: 'F2-014 request requires exact batch revision and one item revision plus failed-step hash per target; serializable persistence recompiles and compares the complete retry aggregate before one atomic CAS',
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
  'apollo.projects.rename': {
    mode: 'revision-bound-action', evidence: 'F1.003 requires baseRevision and applies a serializable exact-state CAS before the immutable administration command and event are committed',
  },
  'apollo.projects.archive': {
    mode: 'revision-bound-action', evidence: 'F1.003 requires baseRevision plus explicit confirmation and serializably preserves the exact active status before archiving',
  },
  'apollo.projects.restore': {
    mode: 'revision-bound-action', evidence: 'F1.003 requires baseRevision and restores only the prior status durably recorded by the matching archive transition',
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
  'apollo.projects.long-form-index-workflows.create': {
    mode: 'idempotent-create',
    evidence: 'F2-022 request fingerprint binds the exact artifact, manifest, optional transcript, five provider versions, per-stage budgets, global budget and actor; serializable persistence rechecks project membership, source hashes, rights and actor before atomic operation and checkpoint creation',
  },
  'apollo.projects.contiguous-extractions.create': {
    mode: 'idempotent-create',
    evidence: 'FR-134 request fingerprint binds objective, topic, duration, tolerance, fps and actor; serializable persistence binds the selected immutable evaluation to its exact active index, moment, rights, consent, artifact and manifest lineage',
  },
  'apollo.projects.color-pipeline-compilations.create': {
    mode: 'idempotent-create',
    evidence: 'FR-180 request fingerprint binds project, exact source artifact/manifest, output colorimetry, four transform descriptors and actor; the server loads the immutable trusted probe and derives every stage input before canonical persistence',
  },
  'apollo.projects.treatment-plans.create': {
    mode: 'idempotent-create',
    evidence: 'request fingerprint binds exact project version, immutable Policy Snapshot, server rubric, versioned Perception summary and actor; serializable persistence rechecks project objective, policy hash and active actor',
  },
  'apollo.projects.story-plans.create': {
    mode: 'idempotent-create',
    evidence: 'FR-061 request fingerprint binds exact project/version, complete narrative structure, source references, TreatmentPlan reference and actor; replay cannot mutate or silently replace the plan',
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
  'apollo.projects.semantic-search.reuse-runs.create': {
    mode: 'idempotent-create',
    evidence: 'request fingerprint binds the exact query, queryHash, resultSetHash, complete reuse/rejection partition and actor; the server re-executes retrieval and rejects result drift before serializable immutable persistence',
  },
  'apollo.projects.semantic-search.scale-evaluations.create': {
    mode: 'idempotent-create',
    evidence: 'request fingerprint binds scope, k, every fixed query, relevance judgment and actor; the service rejects library drift during measurement and persistence rechecks the active document count inside the serializable transaction',
  },
  'apollo.projects.hierarchical-processing.runs.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds exact artifact, manifest, transcript, chunk policy, tier versions, prior run hash, budget and actor; serializable persistence rechecks every source and rights identity before replacing the active run',
  },
  'apollo.projects.source-deconstructions.create': {
    mode: 'idempotent-create',
    evidence: 'F2-015 request fingerprint binds the exact artifact SHA-256, active cataloged transcript hash, target role/composition, validation scope, boundary policy and actor; serializable persistence rechecks every immutable source identity before inserting one canonical report',
  },
  'apollo.projects.contamination-reports.create': {
    mode: 'idempotent-create',
    evidence: 'F2-016 request fingerprint binds the exact source-deconstruction report ID/hash, detector evidence, policy, protected regions and actor; serializable persistence rechecks the immutable source report and artifact identity before inserting one canonical diagnosis',
  },
  'apollo.projects.source-cleanups.create': {
    mode: 'idempotent-create',
    evidence: 'F2-017 request fingerprint binds the exact contamination report hash, finding, strategy policy and actor; creation rechecks source artifact, manifest and current rights before atomically persisting one canonical plan and operation',
  },
  'apollo.projects.validation-envelope-reuses.create': {
    mode: 'idempotent-create',
    evidence: 'F2-018 request fingerprint binds exact ValidatedSegment and VariantRecipe hashes, requested changes and actor; serializable creation rechecks both sources before persisting the plan and initial decision',
  },
  'apollo.projects.validation-envelope-reuses.approve': {
    mode: 'validation-envelope-plan-action',
    evidence: 'F2-018 request requires expectedPlanHash; serializable append compares the immutable plan, accepts one sequence-two decision and converges by actor-bound idempotency',
  },
  'apollo.projects.proof-needs.create': {
    mode: 'idempotent-create',
    evidence: 'F2-019 request fingerprint binds the exact VariantRecipe hash, StoryPlan claims, proof classifications and actor; serializable creation rechecks recipe, actor and every selected evidence rights snapshot before persisting',
  },
  'apollo.projects.proof-integrity-runs.create': {
    mode: 'idempotent-create',
    evidence: 'F2-020 request fingerprint binds exact ProofNeed hash, policy, context uses and actor; serializable creation rechecks the immutable recipe, graph nodes, evidence hashes and current rights before persisting',
  },
  'apollo.projects.proof-mode-runs.create': {
    mode: 'idempotent-create',
    evidence: 'F2-021 request fingerprint binds exact ProofIntegrity hash, formats, rhythm, per-segment overrides and actor; serializable creation rechecks approved evaluations, evidence, artifacts and current rights before persisting',
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
  'apollo.projects.director-runs.enqueue': {
    mode: 'base-version-bound-action', evidence: 'request binds immutable baseVersionId and baseHash before allocating a durable fenced Director operation',
  },
  'apollo.projects.director-budgets.create': {
    mode: 'idempotent-create', evidence: 'F1.026 request fingerprint binds the run and immutable six-dimensional limits to one actor audit context',
  },
  'apollo.projects.director-budgets.actions.apply': {
    mode: 'revision-bound-action', evidence: 'F1.026 requires baseRevision and persistence compare-and-swaps that revision before reserve, settle, cancel or conclude',
  },
  'apollo.projects.editorial-beats.derive': {
    mode: 'idempotent-create', evidence: 'request fingerprint and idempotency bind expectedTranscriptHash, immutable project version and the complete word-signal derivation input',
  },
  'apollo.projects.editorial-beats.adjust': {
    mode: 'idempotent-create', evidence: 'request binds an immutable beat set and exact source beat/word IDs to a completed matching DirectorRun; persistence rechecks source and alignment hashes',
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
  'apollo.projects.media-library.attach': {
    mode: 'natural-idempotent-create', evidence: 'the unique project/artifact/selected-insert reference is a natural idempotency key and the serializable transaction rechecks project locale, artifact lifecycle and current rights',
  },
  'apollo.projects.images.reuse': {
    mode: 'natural-idempotent-create', evidence: 'purpose, query, immutable analysis, current rights snapshot and project reference form content-addressed lineage; serializable commit rechecks project locale, artifact lifecycle, rights and consent',
  },
  'apollo.projects.perception.put': {
    mode: 'explicit-precondition', mechanism: 'body-revision', evidence: 'baseRevision is null only for the first timeline and otherwise must equal the latest immutable timelineHash inside the serializable transaction',
  },
  'apollo.media.segments.create': {
    mode: 'natural-idempotent-create', evidence: 'content-addressed segment identity and hash converge while the serializable transaction rechecks immutable source duration and optional parent bounds',
  },
  'apollo.projects.quality-iterations.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds project version, proxy revision/hash, asset selections, rubric evidence, reference dataset and fixed budget; serializable commit rechecks all server evidence',
  },
  'apollo.projects.montage-alternatives.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds the exact StoryPlan contract, all canonical candidate seeds, policy and authenticated actor before immutable selection persistence',
  },
  'apollo.workspace-luts.import': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds workspace, logical LUT ID, canonical .cube hash, license, compatibility, intensity and actor before preview generation',
  },
  'apollo.workspace-luts.versions.create': {
    mode: 'idempotent-create', evidence: 'request fingerprint binds logical LUT, exact baseVersion, canonical .cube hash, license, compatibility, intensity and actor; serializable persistence rechecks the current version',
  },
  'apollo.workspace-luts.lifecycle.set': {
    mode: 'revision-bound-action', evidence: 'request requires baseRevision and serializable persistence records one immutable status command before compare-and-swap',
  },
  'apollo.workspace-luts.default.set': {
    mode: 'revision-bound-action', evidence: 'request requires baseRevision; serializable persistence rechecks workspace default revision and active current LUT before advancing the immutable default version',
  },
  'apollo.projects.lut-selection.set': {
    mode: 'base-version-bound-action', evidence: 'request requires exact baseVersionId/baseHash and serializable persistence rechecks the current ProjectVersion plus resolved workspace default or active LUT',
  },
  'apollo.projects.subtitle-configuration.set': {
    mode: 'base-version-bound-action', evidence: 'request requires exact baseVersionId/baseHash and serializable persistence rechecks the current ProjectVersion plus the per-variant configuration head the command claims to replace',
  },
  'apollo.projects.subtitle-segment-overrides.apply': {
    mode: 'base-version-bound-action', evidence: 'request requires exact baseVersionId/baseHash and serializable persistence rechecks the current ProjectVersion, the compiled segment range of the target variant and the per-segment override head the command claims to replace',
  },
  'apollo.projects.policy-overrides.set': {
    mode: 'base-version-bound-action', evidence: 'request requires exact baseVersionId/baseHash and serializable persistence rechecks the current ProjectVersion, inherited policy values and completed output set',
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
  'apollo.governance.policies.set': {
    mode: 'explicit-precondition', mechanism: 'body-revision',
    evidence: 'F0.100 requires explicit baseRevision null for create or the exact current revision for replacement and rechecks the scope under a serializable workspace/environment lock',
  },
  'apollo.governance.policies.delete': {
    mode: 'explicit-precondition', mechanism: 'body-revision',
    evidence: 'F0.100 requires the exact current revision and explicit confirmation before atomic policy deletion plus immutable command audit',
  },
  'apollo.sessions.login': { mode: 'state-machine-action', evidence: 'credential verification creates a bounded server-signed session' },
  'apollo.sessions.oidc-start': { mode: 'state-machine-action', evidence: 'same-origin request creates an expiring browser-bound PKCE transaction' },
  'apollo.sessions.oidc-callback': { mode: 'state-machine-action', evidence: 'state, browser binding, PKCE, nonce, provider signature and membership must all match' },
  'apollo.sessions.logout': { mode: 'state-machine-action', evidence: 'session revocation is naturally idempotent' },
  'apollo.sessions.switch-workspace': { mode: 'state-machine-action', evidence: 'current session nonce and target membership are revalidated atomically' },
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

function requiresSignedBatchEdit(capability) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  for (const field of [
    'expectedPreflightHash',
    'expectedScopeHash',
    'commitToken',
  ]) {
    assert.ok(
      schema.required?.includes(field),
      `${capability.id} must require ${field}`,
    )
    assert.ok(
      schema.properties?.[field],
      `${capability.id} must define ${field}`,
    )
  }
  assert.equal(capability.confirmation, 'preflight-token')
  assert.equal(capability.idempotency, 'required')
}

function requiresBatchPartialRetry(capability) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  assert.ok(
    schema.required?.includes('expectedBatchRevision'),
    `${capability.id} must require expectedBatchRevision`,
  )
  assert.ok(
    schema.required?.includes('targets'),
    `${capability.id} must require targets`,
  )
  const target = schema.properties?.targets?.items
  for (const field of [
    'itemId',
    'step',
    'expectedItemRevision',
    'expectedStepHash',
  ]) {
    assert.ok(
      target?.required?.includes(field),
      `${capability.id} targets must require ${field}`,
    )
    assert.ok(
      target?.properties?.[field],
      `${capability.id} targets must define ${field}`,
    )
  }
  assert.equal(capability.idempotency, 'required')
}

function requiresValidationEnvelopePlan(capability) {
  assert.ok(capability.inputSchemaRef, `${capability.id} must publish an input schema`)
  const schema = getPublicSchema(capability.inputSchemaRef).schema
  assert.ok(
    schema.required?.includes('expectedPlanHash'),
    `${capability.id} must require expectedPlanHash`,
  )
  assert.ok(
    schema.properties?.expectedPlanHash,
    `${capability.id} must define expectedPlanHash`,
  )
  assert.equal(capability.idempotency, 'required')
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
    if (decision.mode === 'batch-edit-signed-action') {
      requiresSignedBatchEdit(capability)
    }
    if (decision.mode === 'batch-partial-retry-action') {
      requiresBatchPartialRetry(capability)
    }
    if (decision.mode === 'validation-envelope-plan-action') {
      requiresValidationEnvelopePlan(capability)
    }
    if (decision.mode === 'idempotent-create') {
      assert.equal(capability.idempotency, 'required')
    }
    if (decision.mode === 'natural-idempotent-create') {
      assert.equal(capability.idempotency, 'natural')
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
    'read-only-preflight': 4,
    'explicit-precondition': 10,
    'idempotent-create': 54,
    'natural-idempotent-create': 3,
    'state-machine-action': 16,
    'single-flight-action': 1,
    'revision-bound-action': 12,
    'base-version-bound-action': 8,
    'production-batch-revision-action': 2,
    'script-alignment-revision-action': 1,
    'take-library-revision-action': 1,
    'batch-edit-signed-action': 1,
    'batch-partial-retry-action': 1,
    'validation-envelope-plan-action': 1,
  })
})
