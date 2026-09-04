import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateSyntheticPhaseGateRecordHash,
  listSyntheticPhaseGatesService,
  runSyntheticPhaseGateService,
} from '../../src/v2/application/run-synthetic-phase-gate.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  SYNTHETIC_PHASE_GATE_CRITERIA,
  SYNTHETIC_PHASE_GATE_CRITERION_CHECKS,
} from '../../src/v2/domain/synthetic-phase-gate.ts'

const hash = (character) => character.repeat(64)
const evidenceTypes = {
  'elevenlabs-audio-alignment-live': ['provider-job', 'provider-result-artifact', 'alignment-artifact'],
  'heygen-generated-audio-avatar-live': ['provider-job', 'synthetic-audio-master', 'provider-result-artifact'],
  'heygen-ready-audio-avatar-live': ['provider-job', 'synthetic-audio-master', 'provider-result-artifact'],
  'approved-blocks-catalogued': ['synthetic-master', 'speech-segment'],
  'cross-project-reuse-with-zero-provider-work': ['cache-decision', 'synthetic-master', 'project'],
  'transformation-rejected-before-fallback': ['transformation-fallback-ledger', 'transformation-critic-report'],
  'fallback-result-approved': ['transformation-fallback-ledger', 'provider-result-artifact'],
  'provider-swap-keeps-plan-and-renderer-contracts': ['edit-plan', 'render-manifest', 'build-attestation'],
}

function completeEvidence() {
  let sequence = 0
  return SYNTHETIC_PHASE_GATE_CRITERIA.map((criterion) => ({
    criterion,
    checks: SYNTHETIC_PHASE_GATE_CRITERION_CHECKS[criterion].map((code) => ({
      code,
      passed: true,
      references: evidenceTypes[code].map((type) => ({
        type,
        id: `${type}-${++sequence}`,
        hash: hash(((sequence % 9) + 1).toString()),
      })),
    })),
  }))
}

const auditContext = createExternalAuditContext({
  clientId: 'client-synthetic-gate',
  credentialId: 'credential-synthetic-gate',
  workspaceId: 'workspace-synthetic-gate',
  environment: 'production',
})
const actor = Object.freeze({
  ...auditContext,
  scopes: new Set(['projects:read', 'projects:write']),
  authenticationKind: 'bearer',
  clientKillSwitchEngaged: false,
  workspaceKillSwitchEngaged: false,
  clientAccessStatus: 'active',
  workspaceAccessStatus: 'active',
  auditContext,
})

const request = {
  workspaceId: actor.workspaceId,
  projectId: 'project-synthetic-gate',
  projectVersionId: 'version-synthetic-gate',
  projectVersionHash: hash('a'),
  actor,
  idempotencyKey: 'synthetic-gate-request-1',
}

function repository(overrides = {}) {
  const persisted = []
  return {
    persisted,
    async findIdempotent() { return null },
    async readEvidence() {
      return {
        projectVersionId: request.projectVersionId,
        projectVersionHash: request.projectVersionHash,
        evidence: completeEvidence(),
      }
    },
    async persist(gate, audit) {
      persisted.push({ gate, audit })
      return { gate, replayed: false }
    },
    async list() { return persisted.map((entry) => entry.gate) },
    ...overrides,
  }
}

test('T-F3-GATE derives an approved immutable gate only from repository evidence', async () => {
  const store = repository()
  const result = await runSyntheticPhaseGateService({
    repository: store,
    clock: () => new Date('2026-09-03T12:30:00.000Z'),
    createId: () => 'synthetic-phase-gate-1',
  })(request)

  assert.equal(result.replayed, false)
  assert.equal(result.gate.report.approved, true)
  assert.equal(result.gate.report.serverEvidenceOnly, true)
  assert.equal(result.gate.reportFingerprint, result.gate.report.fingerprint)
  const { recordHash, ...content } = result.gate
  assert.equal(
    recordHash,
    calculateSyntheticPhaseGateRecordHash(content),
  )
  assert.equal(store.persisted.length, 1)
  assert.equal(store.persisted[0].audit.clientId, actor.clientId)
  assert.equal(store.persisted[0].audit.credentialId, actor.credentialId)
})

test('T-F3-GATE replays the same actor request and rejects payload drift', async () => {
  const firstStore = repository()
  const service = runSyntheticPhaseGateService({
    repository: firstStore,
    clock: () => new Date('2026-09-03T12:30:00.000Z'),
    createId: () => 'synthetic-phase-gate-1',
  })
  const first = await service(request)
  const replayStore = repository({
    async findIdempotent() { return first.gate },
    async readEvidence() { assert.fail('replay must not read mutable evidence') },
    async persist() { assert.fail('replay must not persist another gate') },
  })
  const replay = await runSyntheticPhaseGateService({
    repository: replayStore,
    clock: () => new Date('2030-01-01T00:00:00.000Z'),
    createId: () => 'must-not-be-used',
  })(request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.gate.recordHash, first.gate.recordHash)

  await assert.rejects(
    () => runSyntheticPhaseGateService({
      repository: replayStore,
      clock: () => new Date(),
      createId: () => 'must-not-be-used',
    })({ ...request, projectVersionHash: hash('b') }),
    /different synthetic phase gate request/,
  )
})

test('T-F3-GATE refuses stale versions, foreign workspaces and missing scope', async () => {
  const staleStore = repository({
    async readEvidence() {
      return {
        projectVersionId: 'version-newer',
        projectVersionHash: hash('b'),
        evidence: completeEvidence(),
      }
    },
  })
  await assert.rejects(
    () => runSyntheticPhaseGateService({
      repository: staleStore,
      clock: () => new Date(),
      createId: () => 'synthetic-phase-gate-stale',
    })(request),
    (error) => error.code === 'VERSION_CONFLICT',
  )

  await assert.rejects(
    () => runSyntheticPhaseGateService({
      repository: repository(),
      clock: () => new Date(),
      createId: () => 'synthetic-phase-gate-foreign',
    })({ ...request, workspaceId: 'workspace-foreign' }),
    (error) => error.code === 'AUTH_INVALID',
  )

  await assert.rejects(
    () => runSyntheticPhaseGateService({
      repository: repository(),
      clock: () => new Date(),
      createId: () => 'synthetic-phase-gate-scope',
    })({ ...request, actor: { ...actor, scopes: new Set(['projects:read']) } }),
    (error) => error.code === 'AUTH_SCOPE_REQUIRED',
  )
})

test('T-F3-GATE list is bounded and delegates only normalized identities', async () => {
  const calls = []
  const list = listSyntheticPhaseGatesService({
    repository: repository({
      async list(input) { calls.push(input); return [] },
    }),
  })
  assert.deepEqual(await list({
    workspaceId: ' workspace-synthetic-gate ',
    projectId: ' project-synthetic-gate ',
    limit: 25,
  }), [])
  assert.deepEqual(calls, [{
    workspaceId: 'workspace-synthetic-gate',
    projectId: 'project-synthetic-gate',
    limit: 25,
  }])
  await assert.rejects(
    () => list({ workspaceId: actor.workspaceId, projectId: request.projectId, limit: 101 }),
    /between 1 and 100/,
  )
})
