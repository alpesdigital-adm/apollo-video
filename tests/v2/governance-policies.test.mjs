import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deleteGovernancePolicyService,
  listGovernancePoliciesService,
  setGovernancePolicyService,
} from '../../src/v2/application/governance-policies.ts'
import {
  createGovernancePolicy,
} from '../../src/v2/domain/governance-limits.ts'
import {
  calculateGovernancePolicyCommandResultHash,
  createGovernancePolicyCommand,
} from '../../src/v2/domain/governance-policy-command.ts'
import {
  PrismaGovernancePolicyRepository,
} from '../../src/v2/infrastructure/prisma/governance-policy-repository.ts'
import {
  authenticatedActor,
  authenticationAudit,
} from './helpers/authentication-audit.mjs'

const workspaceId = 'workspace-audit-test'
const limits = {
  requestsPerMinute: 100,
  maxConcurrency: 4,
  quotaUnits: 1000,
  spendBudgetMinorUnits: 2000,
}

class PolicyRepository {
  policies = new Map()
  commands = new Map()

  async list({ workspaceId: requested }) {
    return [...this.policies.values()].filter((policy) =>
      policy.workspaceId === requested)
  }

  async findByScope(input) {
    return [...this.policies.values()].find((policy) =>
      policy.workspaceId === input.workspaceId &&
      policy.scopeType === input.scopeType && policy.scopeId === input.scopeId &&
      policy.environment === input.environment) ?? null
  }

  async findById({ workspaceId: requested, policyId }) {
    const policy = this.policies.get(policyId)
    return policy?.workspaceId === requested ? policy : null
  }

  async findReplay(input) {
    const key = `${input.workspaceId}:${input.actorContextHash}:${input.idempotencyKey}`
    const stored = this.commands.get(key)
    if (!stored) return null
    if (stored.requestFingerprint !== input.requestFingerprint) {
      const error = new Error('idempotency mismatch')
      error.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH'
      throw error
    }
    return { ...stored.result, replayed: true }
  }

  remember(command, result) {
    const key = `${command.workspaceId}:${command.audit.contextHash}:${command.idempotencyKey}`
    this.commands.set(key, {
      requestFingerprint: command.requestFingerprint,
      result,
    })
  }

  async applySet({ policy, command }) {
    this.policies.set(policy.id, policy)
    const result = {
      action: 'set', policy, commandHash: command.commandHash, replayed: false,
    }
    this.remember(command, result)
    return result
  }

  async applyDelete({ command }) {
    this.policies.delete(command.policyId)
    const result = {
      action: 'delete', deletedPolicyId: command.policyId,
      commandHash: command.commandHash, replayed: false,
    }
    this.remember(command, result)
    return result
  }
}

function adminActor(overrides = {}) {
  return authenticatedActor({ scopes: ['clients:admin'], ...overrides })
}

test('governance policy lifecycle is workspace-scoped, CAS-bound and idempotent', async () => {
  const repository = new PolicyRepository()
  let sequence = 0
  const set = setGovernancePolicyService({
    repository,
    clock: () => new Date(`2026-08-05T02:00:0${sequence}.000Z`),
    createId: (kind) => `governance-${kind}-${++sequence}`,
  })
  const request = {
    actor: adminActor(),
    workspaceId,
    scopeType: 'client',
    scopeId: 'client-governed-1',
    environment: 'sandbox',
    limits,
    reason: 'Apply approved client limits.',
    confirmed: true,
    idempotencyKey: 'governance-policy-create-1',
  }
  const created = await set(request)
  assert.equal(created.action, 'set')
  assert.equal(created.replayed, false)
  assert.equal(created.policy.scopeId, 'client-governed-1')
  assert.match(created.policy.revision, /^[a-f0-9]{64}$/)
  assert.match(created.commandHash, /^[a-f0-9]{64}$/)
  assert.equal((await listGovernancePoliciesService({ repository })({
    actor: adminActor(), workspaceId,
  })).length, 1)

  const replay = await set(request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.commandHash, created.commandHash)
  assert.equal(repository.commands.size, 1)
  await assert.rejects(
    set({
      ...request,
      limits: { ...limits, requestsPerMinute: 101 },
    }),
    (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  const updated = await set({
    ...request,
    limits: { ...limits, requestsPerMinute: 80 },
    baseRevision: created.policy.revision,
    idempotencyKey: 'governance-policy-update-1',
  })
  assert.equal(updated.policy.id, created.policy.id)
  assert.notEqual(updated.policy.revision, created.policy.revision)
  await assert.rejects(
    set({
      ...request,
      limits: { ...limits, requestsPerMinute: 70 },
      baseRevision: created.policy.revision,
      idempotencyKey: 'governance-policy-update-stale',
    }),
    (error) => error?.code === 'VERSION_CONFLICT',
  )

  const remove = deleteGovernancePolicyService({
    repository,
    clock: () => new Date('2026-08-05T02:01:00.000Z'),
    createId: () => 'governance-command-delete-1',
  })
  await assert.rejects(
    remove({
      actor: adminActor(), workspaceId, policyId: updated.policy.id,
      baseRevision: updated.policy.revision,
      reason: 'Restore defaults.', confirmed: false,
      idempotencyKey: 'governance-policy-delete-1',
    }),
    (error) => error?.code === 'TOOL_CONFIRMATION_REQUIRED',
  )
  const deleted = await remove({
    actor: adminActor(), workspaceId, policyId: updated.policy.id,
    baseRevision: updated.policy.revision,
    reason: 'Restore defaults.', confirmed: true,
    idempotencyKey: 'governance-policy-delete-1',
  })
  assert.equal(deleted.deletedPolicyId, updated.policy.id)
  assert.equal(repository.policies.size, 0)
  const deleteReplay = await remove({
    actor: adminActor(), workspaceId, policyId: updated.policy.id,
    baseRevision: updated.policy.revision,
    reason: 'Restore defaults.', confirmed: true,
    idempotencyKey: 'governance-policy-delete-1',
  })
  assert.equal(deleteReplay.replayed, true)
})

test('governance policy administration rejects missing scope and cross-workspace access before persistence', async () => {
  const repository = new PolicyRepository()
  const execute = setGovernancePolicyService({ repository })
  const request = {
    actor: adminActor(), workspaceId,
    scopeType: 'workspace', scopeId: workspaceId,
    environment: 'sandbox', limits,
    reason: 'Apply approved workspace limits.', confirmed: true,
    idempotencyKey: 'governance-policy-auth-1',
  }
  await assert.rejects(
    execute({ ...request, actor: adminActor({ scopes: ['projects:read'] }) }),
    (error) => error?.code === 'AUTH_SCOPE_REQUIRED',
  )
  await assert.rejects(
    execute({ ...request, workspaceId: 'workspace-other' }),
    (error) => error?.code === 'WORKSPACE_NOT_FOUND',
  )
  assert.equal(repository.policies.size, 0)
  assert.equal(repository.commands.size, 0)
})

test('governance policy command hash binds actor, transition and durable result', () => {
  const audit = authenticationAudit()
  const policy = createGovernancePolicy({
    id: 'governance-policy-domain-1', workspaceId,
    scopeType: 'workspace', scopeId: workspaceId,
    environment: 'sandbox', limits,
    updatedByClientId: audit.clientId,
    createdAt: '2026-08-05T02:00:00.000Z',
    updatedAt: '2026-08-05T02:00:00.000Z',
  })
  const resultHash = calculateGovernancePolicyCommandResultHash({
    action: 'set', policy,
  })
  const command = createGovernancePolicyCommand({
    id: 'governance-policy-command-domain-1', workspaceId,
    action: 'set', policyId: policy.id,
    scopeType: policy.scopeType, scopeId: policy.scopeId,
    environment: policy.environment, limits: policy.limits,
    resultRevision: policy.revision,
    reason: 'Apply domain policy.', audit,
    idempotencyKey: 'governance-policy-domain-key',
    requestFingerprint: 'a'.repeat(64), resultHash,
    occurredAt: '2026-08-05T02:00:00.000Z',
  })
  assert.match(command.commandHash, /^[a-f0-9]{64}$/)
  assert.throws(
    () => createGovernancePolicyCommand({
      ...command,
      reason: 'Tampered reason.',
    }),
    (error) => error?.code === 'PERSISTENCE_CONFLICT',
  )
})

test('Prisma governance policy persistence rejects a client outside the workspace/environment before writes', async () => {
  const audit = authenticationAudit()
  const policy = createGovernancePolicy({
    id: 'governance-policy-prisma-1', workspaceId,
    scopeType: 'client', scopeId: 'client-outside-1',
    environment: 'sandbox', limits,
    updatedByClientId: audit.clientId,
    createdAt: '2026-08-05T02:00:00.000Z',
    updatedAt: '2026-08-05T02:00:00.000Z',
  })
  const resultHash = calculateGovernancePolicyCommandResultHash({
    action: 'set', policy,
  })
  const command = createGovernancePolicyCommand({
    id: 'governance-policy-command-prisma-1', workspaceId,
    action: 'set', policyId: policy.id,
    scopeType: policy.scopeType, scopeId: policy.scopeId,
    environment: policy.environment, limits: policy.limits,
    resultRevision: policy.revision,
    reason: 'Reject foreign client.', audit,
    idempotencyKey: 'governance-policy-prisma-key',
    requestFingerprint: 'b'.repeat(64), resultHash,
    occurredAt: '2026-08-05T02:00:00.000Z',
  })
  let writes = 0
  const transaction = {
    async $queryRaw() { return [{ pg_advisory_xact_lock: null }] },
    v2ApiClient: { async findUnique() { return null } },
    v2GovernancePolicy: {
      async findUnique() { return null },
      async create() { writes += 1 },
    },
    v2GovernancePolicyCommand: {
      async create() { writes += 1 },
    },
  }
  const repository = new PrismaGovernancePolicyRepository({
    async $transaction(callback) { return callback(transaction) },
    v2GovernancePolicyCommand: { async findUnique() { return null } },
  })
  await assert.rejects(
    repository.applySet({ policy, command, audit }),
    (error) => error?.code === 'API_CLIENT_NOT_FOUND',
  )
  assert.equal(writes, 0)
})
