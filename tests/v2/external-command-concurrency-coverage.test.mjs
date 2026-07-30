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
  'apollo.batches.create': {
    mode: 'durable-covered',
    evidence: 'F2-007 serializable explicit-item creation, actor-bound idempotency ledger, normalized PostgreSQL constraints and public API E2E',
  },
  'apollo.batches.actions.apply': {
    mode: 'durable-covered',
    evidence: 'F2-007 exact batch revision CAS, serializable action ledger, idempotent response snapshot and cancel/resume public API E2E',
  },
  'apollo.batches.items.actions.apply': {
    mode: 'durable-covered',
    evidence: 'F2-007 exact batch plus item revision CAS, serializable independent step transition, artifact preservation and partial retry public API E2E',
  },
  'apollo.batches.script-alignments.create': {
    mode: 'durable-covered',
    evidence: 'F2-008 serializable transcript and rights revalidation, actor-bound idempotency ledger, immutable source hashes and public API E2E',
  },
  'apollo.batches.script-alignments.reviews.apply': {
    mode: 'durable-covered',
    evidence: 'F2-008 exact alignment revision CAS, serializable review ledger, immutable result snapshot and stale-review public API E2E',
  },
  'apollo.batches.take-libraries.create': {
    mode: 'durable-covered',
    evidence: 'F2-009 serializable exact-alignment creation, actor-bound idempotency ledger, immutable source evidence and public API E2E',
  },
  'apollo.batches.take-libraries.selections.apply': {
    mode: 'durable-covered',
    evidence: 'F2-009 exact take-library revision CAS, serializable selection ledger, protected-take precondition and public API E2E',
  },
  'apollo.batches.compatibility-graphs.create': {
    mode: 'durable-covered',
    evidence: 'F2-010 serializable exact take-library hash binding, graph-scoped immutable node/edge identities, actor-bound idempotency ledger and repeated-calculation PostgreSQL/API E2E',
  },
  'apollo.batches.variant-recipes.create': {
    mode: 'durable-covered',
    evidence: 'F2-011 serializable exact compatibility-graph hash binding, graph-scoped recipe/lineage foreign keys, actor-bound idempotency ledger and PostgreSQL/API E2E',
  },
  'apollo.batches.variant-portfolio-preflights.create': {
    mode: 'durable-covered',
    evidence: 'F2-012 serializable exact graph/policy/batch binding, actor-bound idempotency, immutable count and estimate projections, signed expansion confirmation and PostgreSQL/API E2E',
  },
  'apollo.batches.edit-preflights.create': {
    mode: 'durable-covered',
    evidence: 'F2-013 immutable exact recipe/format/item scope, actor-bound idempotency, state-hash binding, sampled diff, protected conflicts, budget and signed commit-token PostgreSQL/API E2E',
  },
  'apollo.batches.edit-preflights.commit': {
    mode: 'durable-covered',
    evidence: 'F2-013 signed preflight and scope hashes, serializable current-state and budget revalidation, immutable state lineage, all-or-nothing or skip-failures item results and PostgreSQL/API E2E',
  },
  'apollo.batches.partial-retries.create': {
    mode: 'durable-covered',
    evidence: 'F2-014 exact batch, item and failed-step hash CAS, serializable action plus retry-job ledger, deterministic manifest recompile, actor-bound idempotency and mixed provider/render/validator PostgreSQL/API E2E',
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
  'apollo.projects.duplicates.create': {
    mode: 'durable-covered', evidence: 'F1-051 serializable source-version binding, shared immutable artifacts and idempotent public API E2E',
  },
  'apollo.projects.mvp-core-gates.run': {
    mode: 'durable-covered', evidence: 'F1-051 immutable server-evidence report, exact dual-version binding and idempotent serializable persistence',
  },
  'apollo.projects.speech-segments.catalog': {
    mode: 'durable-covered', evidence: 'F2-001 exact transcript-hash binding, immutable virtual segment rows, one active serializable run and idempotent public API E2E',
  },
  'apollo.projects.evidence-segments.catalog': {
    mode: 'durable-covered', evidence: 'F2-002 exact SpeechSegment-hash and rights-snapshot binding, immutable serializable persistence and idempotent public API E2E',
  },
  'apollo.projects.long-form-moments.catalog': {
    mode: 'durable-covered', evidence: 'F2-003 exact artifact/manifest/rights binding, immutable hierarchical virtual rows, one active serializable index and idempotent public API E2E',
  },
  'apollo.projects.long-form-index-workflows.create': {
    mode: 'durable-covered',
    evidence: 'F2-022 atomic public operation, workflow and five-checkpoint creation with actor-bound idempotency, serializable source revalidation and immutable canonical hashes',
  },
  'apollo.projects.contiguous-extractions.create': {
    mode: 'durable-covered',
    evidence: 'FR-134 actor-bound idempotency, exact immutable evaluation and source-lineage binding, deterministic single-range selection and serializable PostgreSQL persistence',
  },
  'apollo.projects.validated-segments.catalog': {
    mode: 'durable-covered', evidence: 'F2-004 exact artifact/manifest/SpeechSegment/rights binding, immutable serializable validation record and idempotent public API E2E',
  },
  'apollo.projects.semantic-search.documents.catalog': {
    mode: 'durable-covered', evidence: 'F2-005 exact source-hash and rights binding, one active identity enforced by partial uniqueness, serializable retry and idempotent public API E2E',
  },
  'apollo.projects.semantic-search.evaluations.create': {
    mode: 'durable-covered', evidence: 'F2-005 immutable evaluation report, workspace-scoped idempotency and concurrent duplicate collapse in PostgreSQL E2E',
  },
  'apollo.projects.hierarchical-processing.runs.create': {
    mode: 'durable-covered', evidence: 'F2-006 exact artifact/manifest/transcript/rights binding, tier-level transitive invalidation, serializable active-run replacement and idempotent public API E2E',
  },
  'apollo.projects.source-deconstructions.create': {
    mode: 'durable-covered',
    evidence: 'F2-015 exact artifact and active cataloged-transcript hash binding, actor-bound idempotency ledger, immutable normalized segment/range projections and serializable PostgreSQL/API E2E',
  },
  'apollo.projects.contamination-reports.create': {
    mode: 'durable-covered',
    evidence: 'F2-016 exact source-deconstruction report hash binding, actor-bound idempotency ledger, immutable normalized observation/finding/overlap projections and serializable PostgreSQL/API E2E',
  },
  'apollo.projects.source-cleanups.create': {
    mode: 'durable-covered',
    evidence: 'F2-017 exact contamination report/finding/artifact/manifest/rights binding, actor-bound idempotency ledger, atomic immutable plan plus durable operation and serializable PostgreSQL/API E2E',
  },
  'apollo.projects.validation-envelope-reuses.create': {
    mode: 'durable-covered',
    evidence: 'F2-018 exact ValidatedSegment and VariantRecipe hash binding, actor-bound idempotency, serializable immutable plan plus initial decision and PostgreSQL/API E2E',
  },
  'apollo.projects.validation-envelope-reuses.approve': {
    mode: 'durable-covered',
    evidence: 'F2-018 exact plan-hash precondition, actor-bound idempotency, serializable append-only approval decision and PostgreSQL/API E2E',
  },
  'apollo.projects.proof-needs.create': {
    mode: 'durable-covered',
    evidence: 'F2-019 exact VariantRecipe StoryPlan hash binding, actor-bound idempotency, serializable rights revalidation, immutable proof declarations and PostgreSQL/API E2E',
  },
  'apollo.projects.proof-integrity-runs.create': {
    mode: 'durable-covered',
    evidence: 'F2-020 exact ProofNeed, VariantRecipe, CompatibilityGraph node, EvidenceSegment and current-rights binding, actor-bound idempotency, serializable revalidation and PostgreSQL/API E2E',
  },
  'apollo.projects.proof-mode-runs.create': {
    mode: 'durable-covered',
    evidence: 'F2-021 exact ProofIntegrity, ProofNeed, EvidenceSegment, artifact, output-format and evaluation-hash binding, actor-bound idempotency and serializable source revalidation',
  },
  'apollo.projects.annotations.create': {
    mode: 'durable-covered', evidence: 'F1-040 version-bound annotation idempotency and Postgres integration E2E',
  },
  'apollo.projects.review-patches.propose': {
    mode: 'durable-covered', evidence: 'F1-043 version-bound persisted proposal and idempotent public API E2E',
  },
  'apollo.projects.review-patches.apply': {
    mode: 'durable-covered', evidence: 'F1-043 transactional proposal transition, Command, snapshot and immutable child version E2E',
  },
  'apollo.projects.review-patch-batches.propose': {
    mode: 'durable-covered', evidence: 'F1-044 persisted proposal set, deterministic conflict report and public API E2E',
  },
  'apollo.projects.review-patch-batches.apply': {
    mode: 'durable-covered', evidence: 'F1-044 serializable all-or-nothing transaction, rollback injection, partial retry and public API E2E',
  },
  'apollo.projects.commands.apply': {
    mode: 'durable-covered', evidence: 'typed Command, exact immutable base and transactional ProjectVersion persistence',
  },
  'apollo.projects.manual-edits.apply': {
    mode: 'durable-covered', evidence: 'F1-045 exact revision, serializable Command/snapshot/version transaction, immutable undo/redo and public API E2E',
  },
  'apollo.projects.version-comparisons.act': {
    mode: 'durable-covered', evidence: 'F1-046 exact revision, serializable compare-action Command/status transition or immutable restore child version and public API E2E',
  },
  'apollo.projects.proxy-renders.enqueue': {
    mode: 'durable-covered', evidence: 'project proxy render operation, fenced worker lease and immutable EditPlan identity',
  },
  'apollo.projects.proxy-reviews.acknowledge-warnings': {
    mode: 'durable-covered', evidence: 'F1-047 serializable exact-review CAS, append-only decision, idempotent replay and public API E2E',
  },
  'apollo.projects.asset-selections.create': {
    mode: 'durable-covered', evidence: 'F1-049 serializable exact-version and exact-rights commit, immutable audit, idempotent replay and public API E2E',
  },
  'apollo.projects.quality-iterations.create': {
    mode: 'durable-covered', evidence: 'F1-050 serializable exact-version, proxy-review and asset-selection commit with immutable hash, sequence and public API E2E',
  },
  'apollo.projects.final-exports.enqueue': {
    mode: 'durable-covered', evidence: 'final export operation binds explicit approval, immutable ProjectVersion, DirectorRun and QualitySnapshot',
  },
  'apollo.media.uploads.begin': {
    mode: 'durable-covered', evidence: 'F0-086',
  },
  'apollo.media.uploads.session.issue': {
    mode: 'durable-covered', evidence: 'F0-087',
  },
  'apollo.media.uploads.parts.record': { mode: 'durable-covered', evidence: 'F0-088' },
  'apollo.media.uploads.complete': { mode: 'durable-covered', evidence: 'F0-088' },
  'apollo.media.uploads.abort': { mode: 'durable-covered', evidence: 'atomic upload state transition followed by idempotent staged-byte cleanup' },
  'apollo.media.uploads.content.put': { mode: 'durable-covered', evidence: 'signed immutable upload intent and atomic content storage tests' },
  'apollo.artifacts.download-grants.issue': { mode: 'durable-covered', evidence: 'F0-089' },
  'apollo.artifacts.download-grants.revoke': { mode: 'durable-covered', evidence: 'F0-089' },
  'apollo.clients.create': {
    mode: 'durable-covered', evidence: 'F0-061',
  },
  'apollo.clients.credentials.rotate': {
    mode: 'durable-covered', evidence: 'F0-062',
  },
  'apollo.clients.credentials.revoke': {
    mode: 'durable-covered', evidence: 'F0-073',
  },
  'apollo.sessions.login': { mode: 'durable-covered', evidence: 'bounded signed UI session contract tests' },
  'apollo.sessions.logout': { mode: 'durable-covered', evidence: 'idempotent UI session revocation contract tests' },
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
    76,
  )
  assert.equal(
    Object.values(coverage).filter((entry) => entry.mode === 'read-only-deterministic').length,
    2,
  )
})
