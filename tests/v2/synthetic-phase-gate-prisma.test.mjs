import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { runSyntheticPhaseGateService } from '../../src/v2/application/run-synthetic-phase-gate.ts'
import { PrismaSyntheticPhaseGateRepository } from '../../src/v2/infrastructure/prisma/synthetic-phase-gate-repository.ts'

const versionHash = 'a'.repeat(64)
const auditContext = createExternalAuditContext({
  clientId: 'client-synthetic-gate',
  credentialId: 'credential-synthetic-gate',
  workspaceId: 'workspace-synthetic-gate',
  environment: 'production',
})
const actor = Object.freeze({
  ...auditContext,
  scopes: new Set(['projects:write']),
  authenticationKind: 'bearer',
  clientKillSwitchEngaged: false,
  workspaceKillSwitchEngaged: false,
  clientAccessStatus: 'active',
  workspaceAccessStatus: 'active',
  auditContext,
})

function controlledPrisma() {
  const state = { row: null, creates: 0 }
  const gates = {
    async findFirst({ where }) {
      if (!state.row) return null
      return Object.entries(where).every(([key, value]) => state.row[key] === value)
        ? state.row
        : null
    },
    async findMany() { return state.row ? [state.row] : [] },
    async create({ data }) {
      state.creates += 1
      const { evidence, ...gate } = data
      state.row = {
        ...gate,
        delegatedUserId: gate.delegatedUserId ?? null,
        delegatedIdentityId: gate.delegatedIdentityId ?? null,
        workspaceRole: gate.workspaceRole ?? null,
        evidence: evidence.create.map((item) => ({ gateId: gate.id, ...item })),
      }
      return state.row
    },
  }
  const project = {
    async findFirst() {
      return {
        id: 'project-synthetic-gate',
        currentVersion: { id: 'version-synthetic-gate', baseHash: versionHash },
      }
    },
  }
  const apiClient = { async findFirst() { return { id: actor.clientId } } }
  const transaction = {
    v2SyntheticPhaseGate: gates,
    v2Project: project,
    v2ApiClient: apiClient,
  }
  return {
    state,
    client: {
      ...transaction,
      async $transaction(callback) { return callback(transaction) },
    },
  }
}

test('T-F3-GATE Prisma adapter persists a truthful rejected gate and replays it', async () => {
  const controlled = controlledPrisma()
  const repository = new PrismaSyntheticPhaseGateRepository(controlled.client)
  const service = runSyntheticPhaseGateService({
    repository,
    clock: () => new Date('2026-09-04T10:00:00.000Z'),
    createId: () => 'synthetic-phase-gate-prisma-1',
  })
  const request = {
    workspaceId: actor.workspaceId,
    projectId: 'project-synthetic-gate',
    projectVersionId: 'version-synthetic-gate',
    projectVersionHash: versionHash,
    actor,
    idempotencyKey: 'synthetic-phase-gate-prisma-request-1',
  }

  const created = await service(request)
  assert.equal(created.replayed, false)
  assert.equal(created.gate.report.approved, false)
  assert.equal(created.gate.report.covered, 0)
  assert.equal(controlled.state.creates, 1)
  assert.equal(controlled.state.row.actorCredentialId, auditContext.credentialId)
  assert.deepEqual(controlled.state.row.evidence, [])

  const replay = await service(request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.gate.recordHash, created.gate.recordHash)
  assert.equal(controlled.state.creates, 1)
  assert.equal((await repository.list({
    workspaceId: actor.workspaceId,
    projectId: request.projectId,
    limit: 20,
  })).length, 1)

  controlled.state.row = {
    ...controlled.state.row,
    reportFingerprint: 'f'.repeat(64),
  }
  await assert.rejects(
    repository.list({
      workspaceId: actor.workspaceId,
      projectId: request.projectId,
      limit: 20,
    }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
})

