import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createTreatmentPlanService, readTreatmentPlanService } from '../../src/v2/application/treatment-plans.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { PrismaTreatmentPlanRepository } from '../../src/v2/infrastructure/prisma/treatment-plan-repository.ts'
import { parseCreateTreatmentPlanBody } from '../../src/v2/public-api/treatment-plan-contract.ts'

const workspaceId = 'workspace-treatment'
const projectId = 'project-treatment'
const projectVersionId = 'project-version-treatment'
const policySnapshotId = 'project-snapshot-policy-treatment'
const policyHash = 'a'.repeat(64)

function actor(scopes = ['projects:write', 'projects:read']) {
  const auditContext = createExternalAuditContext({ clientId: 'client-treatment', credentialId: 'credential-treatment', workspaceId, environment: 'production' })
  return Object.freeze({
    ...auditContext, scopes: new Set(scopes), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function request(overrides = {}) {
  const perceptionSummary = {
    id: 'perception-summary-treatment', schemaVersion: 1,
    confidence: .91, speakerCoverage: .8, visualVariety: .45,
    evidenceItemCount: 12, durationMs: 30_000,
  }
  return {
    workspaceId, projectId, projectVersionId, policySnapshotId,
    objective: 'sale', mode: 'talking-head',
    perceptionSummary: { ...perceptionSummary, summaryHash: calculateCanonicalHash(perceptionSummary) },
    actor: actor(), idempotencyKey: 'treatment-key-001', ...overrides,
  }
}

function inMemoryRepository() {
  let stored = null
  return {
    get stored() { return stored },
    async loadContext() { return { workspaceId, projectId, projectVersionId, objective: 'sale', policySnapshot: { id: policySnapshotId, schemaVersion: 1, contentHash: policyHash } } },
    async findIdempotent() { return stored },
    async persist(value) { stored = value; return { value, replayed: false } },
    async read({ treatmentPlanId }) { return stored?.id === treatmentPlanId ? stored : null },
  }
}

test('T-FR-060 application creates and reads one immutable plan without a style selector', async () => {
  const repository = inMemoryRepository()
  const create = createTreatmentPlanService({ repository, createId: () => 'treatment-plan-001', clock: () => new Date('2026-08-13T12:00:00.000Z') })
  const created = await create(request())
  assert.equal(created.replayed, false)
  assert.equal(created.value.plan.schemaVersion, 3)
  assert.equal(created.value.plan.provenance.policySnapshotHash, policyHash)
  assert.equal(created.value.plan.ctaPolicy.required, true)
  assert.equal(created.value.plan.proofPolicy.required, true)
  assert.equal(created.value.plan.patternBreaks.allowed.includes('zoom'), false)
  assert.equal(created.value.plan.decisions.length, 4)
  assert.equal((await readTreatmentPlanService({ repository })({ workspaceId, projectId, treatmentPlanId: created.value.id })).treatmentHash, created.value.treatmentHash)
  assert.throws(() => parseCreateTreatmentPlanBody({ ...request(), style: 'cinematic' }), /unknown fields/)
})

test('T-FR-060 replay is actor-bound and objective drift fails closed', async () => {
  const repository = inMemoryRepository()
  const create = createTreatmentPlanService({ repository, createId: () => 'treatment-plan-001' })
  const first = await create(request())
  assert.equal((await create(request())).replayed, true)
  await assert.rejects(() => create(request({ mode: 'visual-montage' })), /another TreatmentPlan request/)
  await assert.rejects(() => create(request({ objective: 'discovery', idempotencyKey: 'treatment-key-002' })), /objective does not match/)
  assert.match(first.value.treatmentHash, /^[a-f0-9]{64}$/)
})

function controlledPrisma() {
  const state = { row: null }
  const policyContent = { schemaVersion: 1, state: 'configured' }
  const context = { id: projectVersionId, workspaceId, projectId, project: { objective: 'sale' }, policiesSnapshot: { id: policySnapshotId, kind: 'policies', schemaVersion: 1, contentJson: JSON.stringify(policyContent), contentHash: calculateCanonicalHash(policyContent) } }
  const client = {
    v2ProjectVersion: { async findFirst() { return context } },
    v2TreatmentPlan: {
      async findUnique() { return state.row },
      async findFirst({ where }) { return state.row?.id === where.id ? state.row : null },
    },
    async $transaction(callback) {
      return callback({
        v2ProjectVersion: { async findFirst() { return context } },
        v2ApiClient: { async findFirst() { return { id: 'client-treatment' } } },
        v2TreatmentPlan: { async create({ data }) { state.row = { ...data, delegatedUserId: data.delegatedUserId ?? null, delegatedIdentityId: data.delegatedIdentityId ?? null, workspaceRole: data.workspaceRole ?? null }; return state.row } },
      })
    },
  }
  return { client, state }
}

test('T-FR-060 Prisma adapter revalidates exact version/policy and rejects stored tampering', async () => {
  const controlled = controlledPrisma()
  const repository = new PrismaTreatmentPlanRepository(controlled.client)
  const create = createTreatmentPlanService({ repository, createId: () => 'treatment-plan-prisma-001', clock: () => new Date('2026-08-13T12:00:00.000Z') })
  const created = await create(request({ idempotencyKey: 'treatment-prisma-001' }))
  assert.equal(created.value.plan.provenance.policySnapshotId, policySnapshotId)
  assert.equal((await repository.read({ workspaceId, projectId, treatmentPlanId: created.value.id })).treatmentHash, created.value.treatmentHash)
  controlled.state.row.treatmentHash = 'f'.repeat(64)
  await assert.rejects(() => repository.read({ workspaceId, projectId, treatmentPlanId: created.value.id }), /integrity validation/)
})
