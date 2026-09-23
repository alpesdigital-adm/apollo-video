import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  calculateSyntheticPhaseGateRecordHash,
  runSyntheticPhaseGateService,
} from '../../src/v2/application/run-synthetic-phase-gate.ts'
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

function emptySources() {
  return Object.freeze({
    projectVersionId: 'version-synthetic-gate',
    projectVersionHash: versionHash,
    providerExecutions: Object.freeze([]),
    catalogues: Object.freeze([]),
    reuses: Object.freeze([]),
    transformations: Object.freeze([]),
    swaps: Object.freeze([]),
  })
}

function controlledPrisma(sources = emptySources()) {
  const state = {
    row: null,
    evidenceRows: [],
    creates: 0,
    evidenceWrites: 0,
    failEvidenceWrite: false,
  }
  const hydratedRow = () => state.row
    ? { ...state.row, evidence: [...state.evidenceRows] }
    : null
  const gates = {
    async findFirst({ where }) {
      if (!state.row) return null
      return Object.entries(where).every(([key, value]) => state.row[key] === value)
        ? hydratedRow()
        : null
    },
    async findUnique({ where }) {
      return state.row?.id === where.id ? hydratedRow() : null
    },
    async findMany() { return state.row ? [hydratedRow()] : [] },
    async create({ data }) {
      state.creates += 1
      state.row = {
        ...data,
        delegatedUserId: data.delegatedUserId ?? null,
        delegatedIdentityId: data.delegatedIdentityId ?? null,
        workspaceRole: data.workspaceRole ?? null,
      }
      return hydratedRow()
    },
  }
  const gateEvidence = {
    async createMany({ data }) {
      state.evidenceWrites += 1
      if (state.failEvidenceWrite) throw new Error('controlled evidence write failed')
      state.evidenceRows.push(...data)
      return { count: data.length }
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
    v2SyntheticPhaseGateEvidence: gateEvidence,
    v2Project: project,
    v2ApiClient: apiClient,
  }
  return {
    state,
    transaction,
    evidenceReader: {
      async read() { return sources },
      async readWithClient() { return sources },
    },
    client: {
      ...transaction,
      async $transaction(callback) {
        const beforeRow = state.row
        const beforeEvidence = [...state.evidenceRows]
        try {
          return await callback(transaction)
        } catch (error) {
          state.row = beforeRow
          state.evidenceRows = beforeEvidence
          throw error
        }
      },
    },
  }
}

test('T-F3-GATE Prisma adapter persists a truthful rejected gate and replays it', async () => {
  const controlled = controlledPrisma()
  const repository = new PrismaSyntheticPhaseGateRepository(controlled.client, controlled.evidenceReader)
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
  assert.deepEqual(controlled.state.evidenceRows, [])

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

test('T-F3-GATE Prisma adapter reconciles an exhausted P2034 winner', async () => {
  const controlled = controlledPrisma()
  let attempts = 0
  controlled.client.$transaction = async (callback) => {
    attempts += 1
    if (attempts < 3) throw Object.assign(new Error('serialization conflict'), { code: 'P2034' })
    await callback(controlled.transaction)
    throw Object.assign(new Error('commit conflict after winner'), { code: 'P2034' })
  }
  const repository = new PrismaSyntheticPhaseGateRepository(controlled.client, controlled.evidenceReader)
  const run = runSyntheticPhaseGateService({
    repository,
    clock: () => new Date('2026-09-04T10:00:00.000Z'),
    createId: () => 'synthetic-phase-gate-p2034-winner',
  })
  const result = await run({
    workspaceId: actor.workspaceId,
    projectId: 'project-synthetic-gate',
    projectVersionId: 'version-synthetic-gate',
    projectVersionHash: versionHash,
    actor,
    idempotencyKey: 'synthetic-phase-gate-p2034-winner-request',
  })
  assert.equal(attempts, 3)
  assert.equal(controlled.state.creates, 1)
  assert.equal(result.replayed, true)
  assert.equal(result.gate.id, 'synthetic-phase-gate-p2034-winner')
})

test('T-F3-GATE Prisma adapter keeps exhausted P2034 without winner as persistence conflict', async () => {
  const controlled = controlledPrisma()
  let attempts = 0
  controlled.client.$transaction = async () => {
    attempts += 1
    throw Object.assign(new Error('serialization conflict'), { code: 'P2034' })
  }
  const repository = new PrismaSyntheticPhaseGateRepository(controlled.client, controlled.evidenceReader)
  const run = runSyntheticPhaseGateService({
    repository,
    clock: () => new Date('2026-09-04T10:00:00.000Z'),
    createId: () => 'synthetic-phase-gate-p2034-empty',
  })
  await assert.rejects(
    run({
      workspaceId: actor.workspaceId,
      projectId: 'project-synthetic-gate',
      projectVersionId: 'version-synthetic-gate',
      projectVersionHash: versionHash,
      actor,
      idempotencyKey: 'synthetic-phase-gate-p2034-empty-request',
    }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
  assert.equal(controlled.state.creates, 0)
})

test('T-F3-GATE Prisma adapter reports payload mismatch for a divergent exhausted P2034 winner', async () => {
  const controlled = controlledPrisma()
  let attempts = 0
  controlled.client.$transaction = async (callback) => {
    attempts += 1
    if (attempts < 3) throw Object.assign(new Error('serialization conflict'), { code: 'P2034' })
    await callback(controlled.transaction)
    const requestFingerprint = 'f'.repeat(64)
    const changed = {
      ...controlled.state.row,
      requestFingerprint,
    }
    changed.recordHash = calculateSyntheticPhaseGateRecordHash({
      schemaVersion: changed.schemaVersion,
      id: changed.id,
      workspaceId: changed.workspaceId,
      projectId: changed.projectId,
      projectVersionId: changed.projectVersionId,
      projectVersionHash: changed.projectVersionHash,
      report: JSON.parse(changed.reportJson),
      reportFingerprint: changed.reportFingerprint,
      idempotencyKey: changed.idempotencyKey,
      requestFingerprint,
      createdBy: { type: changed.createdByType, id: changed.createdById },
      createdAt: changed.createdAt.toISOString(),
    })
    controlled.state.row = changed
    throw Object.assign(new Error('divergent winner'), { code: 'P2034' })
  }
  const repository = new PrismaSyntheticPhaseGateRepository(controlled.client, controlled.evidenceReader)
  const run = runSyntheticPhaseGateService({
    repository,
    clock: () => new Date('2026-09-04T10:00:00.000Z'),
    createId: () => 'synthetic-phase-gate-p2034-divergent',
  })
  await assert.rejects(
    run({
      workspaceId: actor.workspaceId,
      projectId: 'project-synthetic-gate',
      projectVersionId: 'version-synthetic-gate',
      projectVersionHash: versionHash,
      actor,
      idempotencyKey: 'synthetic-phase-gate-p2034-divergent-request',
    }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(attempts, 3)
})

test('T-F3-GATE Prisma adapter round-trips a partially covered criterion', async () => {
  const sources = {
    ...emptySources(),
    catalogues: [{
      master: { type: 'synthetic-master', id: 'master-partial', hash: 'b'.repeat(64) },
      segments: [{ type: 'speech-segment', id: 'segment-partial', hash: 'c'.repeat(64) }],
      currentAuthorityValid: true,
    }],
  }
  const controlled = controlledPrisma(Object.freeze(sources))
  const repository = new PrismaSyntheticPhaseGateRepository(controlled.client, controlled.evidenceReader)
  const service = runSyntheticPhaseGateService({
    repository,
    clock: () => new Date('2026-09-04T10:00:00.000Z'),
    createId: () => 'synthetic-phase-gate-prisma-partial',
  })
  const created = await service({
    workspaceId: actor.workspaceId,
    projectId: 'project-synthetic-gate',
    projectVersionId: 'version-synthetic-gate',
    projectVersionHash: versionHash,
    actor,
    idempotencyKey: 'synthetic-phase-gate-prisma-partial-request',
  })
  assert.equal(created.gate.report.covered, 0)
  assert.equal(created.gate.report.passed, 0)
  const partial = created.gate.report.evidence.find(({ criterion }) => criterion === 'F3-GATE-002')
  assert.equal(
    partial.checks.find(({ code }) => code === 'approved-blocks-catalogued').passed,
    true,
  )
  assert.deepEqual(partial.missingChecks, [
    'cross-project-reuse-with-zero-provider-work',
  ])
  assert.deepEqual(created.gate.report.missing, ['F3-GATE-001', 'F3-GATE-003', 'F3-GATE-004'])
  assert.equal(controlled.state.evidenceWrites, 1)
  assert.equal(controlled.state.evidenceRows.length, 2)
  assert.deepEqual(
    new Set(controlled.state.evidenceRows.map(({ evidenceType }) => evidenceType)),
    new Set(['synthetic-master', 'speech-segment']),
  )
  const listed = await repository.list({
    workspaceId: actor.workspaceId,
    projectId: 'project-synthetic-gate',
    limit: 20,
  })
  assert.equal(listed[0].recordHash, created.gate.recordHash)
  assert.equal(listed[0].report.covered, 0)
})

test('T-F3-GATE Prisma adapter rolls back the parent when evidence persistence fails', async () => {
  const sources = {
    ...emptySources(),
    catalogues: [{
      master: { type: 'synthetic-master', id: 'master-atomic', hash: 'd'.repeat(64) },
      segments: [{ type: 'speech-segment', id: 'segment-atomic', hash: 'e'.repeat(64) }],
      currentAuthorityValid: true,
    }],
  }
  const controlled = controlledPrisma(Object.freeze(sources))
  controlled.state.failEvidenceWrite = true
  const run = runSyntheticPhaseGateService({
    repository: new PrismaSyntheticPhaseGateRepository(controlled.client, controlled.evidenceReader),
    clock: () => new Date('2026-09-04T10:00:00.000Z'),
    createId: () => 'synthetic-phase-gate-atomic',
  })
  await assert.rejects(
    run({
      workspaceId: actor.workspaceId,
      projectId: 'project-synthetic-gate',
      projectVersionId: 'version-synthetic-gate',
      projectVersionHash: versionHash,
      actor,
      idempotencyKey: 'synthetic-phase-gate-atomic-request',
    }),
    /controlled evidence write failed/,
  )
  assert.equal(controlled.state.creates, 1)
  assert.equal(controlled.state.evidenceWrites, 1)
  assert.equal(controlled.state.row, null)
  assert.deepEqual(controlled.state.evidenceRows, [])
})
