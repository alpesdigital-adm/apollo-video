import assert from 'node:assert/strict'
import test from 'node:test'

import {
  admitGovernedCapabilityService,
  governanceDefaultLimitsFromEnvironment,
} from '../../src/v2/application/admit-governed-capability.ts'
import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import {
  createGovernanceAdmission,
} from '../../src/v2/domain/governance-admission.ts'
import {
  evaluateGovernanceLimits,
} from '../../src/v2/domain/governance-limits.ts'
import {
  PrismaGovernanceAdmissionRepository,
} from '../../src/v2/infrastructure/prisma/governance-admission-repository.ts'

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'governance-client',
    credentialId: 'governance-credential',
    workspaceId: 'governance-workspace',
    environment: 'production',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

class AdmissionRepository {
  constructor(usage) {
    this.usage = usage
    this.admissions = []
  }

  async admit({ draft, defaultLimits }) {
    const decision = evaluateGovernanceLimits(
      { workspaceId: draft.workspaceId, clientId: draft.clientId },
      defaultLimits,
      this.usage,
      draft.requested,
    )
    const admission = createGovernanceAdmission({
      ...draft,
      allowed: decision.allowed,
      reasons: decision.reasons,
      scopes: {
        workspace: {
          reasons: decision.reasons,
          limits: decision.limits,
          usage: decision.usage,
          remaining: decision.remaining,
        },
        client: {
          reasons: decision.reasons,
          limits: decision.limits,
          usage: decision.usage,
          remaining: decision.remaining,
        },
      },
      requested: decision.requested,
    })
    this.admissions.push(admission)
    return admission
  }
}

test('runtime admission maps capability cost and job concurrency into one durable decision', async () => {
  const repository = new AdmissionRepository({
    requestsInWindow: 0,
    activeConcurrency: 0,
    quotaUnitsUsed: 0,
    spendMinorUnits: 0,
  })
  const admit = admitGovernedCapabilityService({
    repository,
    defaultLimits: {
      requestsPerMinute: 10,
      maxConcurrency: 2,
      quotaUnits: 200,
      spendBudgetMinorUnits: 200,
    },
    clock: () => new Date('2026-08-05T01:00:00.000Z'),
    createId: () => 'governance-admission-runtime-1',
  })
  const result = await admit({
    actor: actor(),
    capability: {
      id: 'apollo.projects.exports.create',
      operationKind: 'job',
      costClass: 'high',
    },
  })
  assert.equal(result.allowed, true)
  assert.deepEqual(result.requested, {
    requests: 1,
    concurrency: 1,
    quotaUnits: 100,
    spendMinorUnits: 100,
  })
  assert.equal(repository.admissions.length, 1)
  assert.match(result.admissionHash, /^[a-f0-9]{64}$/)
})

test('runtime admission persists a blocked decision before returning retryable governance error', async () => {
  const repository = new AdmissionRepository({
    requestsInWindow: 1,
    activeConcurrency: 0,
    quotaUnitsUsed: 0,
    spendMinorUnits: 0,
  })
  const admit = admitGovernedCapabilityService({
    repository,
    defaultLimits: {
      requestsPerMinute: 1,
      maxConcurrency: 2,
      quotaUnits: 200,
      spendBudgetMinorUnits: 200,
    },
    clock: () => new Date('2026-08-05T01:00:00.000Z'),
    createId: () => 'governance-admission-runtime-2',
  })
  await assert.rejects(
    admit({
      actor: actor(),
      capability: {
        id: 'apollo.projects.list',
        operationKind: 'query',
        costClass: 'free',
      },
    }),
    (error) => error?.code === 'GOVERNANCE_LIMIT_EXCEEDED',
  )
  assert.equal(repository.admissions.length, 1)
  assert.deepEqual(repository.admissions[0].reasons, ['RATE_LIMIT'])
})

test('governance defaults fail closed on invalid configuration', () => {
  assert.throws(
    () => governanceDefaultLimitsFromEnvironment({
      APOLLO_GOVERNANCE_REQUESTS_PER_MINUTE: '0',
    }),
    /governance default is invalid/,
  )
})

test('Prisma governance admission retries serialization conflicts only three times', async () => {
  let attempts = 0
  const repository = new PrismaGovernanceAdmissionRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })
  await assert.rejects(
    repository.admit({
      draft: {
        id: 'governance-admission-conflict-1',
        workspaceId: 'governance-workspace',
        clientId: 'governance-client',
        capabilityId: 'apollo.projects.list',
        environment: 'production',
        operationKind: 'query',
        costClass: 'free',
        requested: {
          requests: 1,
          concurrency: 0,
          quotaUnits: 0,
          spendMinorUnits: 0,
        },
        createdAt: '2026-08-05T01:00:00.000Z',
      },
      defaultLimits: {
        requestsPerMinute: 10,
        maxConcurrency: 2,
        quotaUnits: 200,
        spendBudgetMinorUnits: 200,
      },
    }),
    (error) => error?.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('Prisma governance admission evaluates aggregate workspace and client budgets separately', async () => {
  let persistedAdmission
  let persistedAlerts
  const transaction = {
    async $queryRaw() { return [{ pg_advisory_xact_lock: null }] },
    v2GovernancePolicy: {
      async findMany() { return [] },
    },
    v2PublicOperation: {
      async count() { return 0 },
    },
    v2GovernanceAdmission: {
      async count({ where }) {
        if (where.requestedConcurrency) return 0
        return where.clientId ? 1 : 5
      },
      async aggregate() {
        return {
          _sum: {
            requestedQuotaUnits: 0,
            requestedSpendMinorUnits: 0,
          },
        }
      },
      async create({ data }) {
        persistedAdmission = data
        return data
      },
    },
    v2GovernanceAlert: {
      async createMany({ data }) {
        persistedAlerts = data
        return { count: data.length }
      },
    },
  }
  const repository = new PrismaGovernanceAdmissionRepository({
    async $transaction(callback) { return callback(transaction) },
  })
  const result = await repository.admit({
    draft: {
      id: 'governance-admission-dual-scope-1',
      workspaceId: 'governance-workspace',
      clientId: 'governance-client',
      capabilityId: 'apollo.projects.list',
      environment: 'production',
      operationKind: 'query',
      costClass: 'free',
      requested: {
        requests: 1,
        concurrency: 0,
        quotaUnits: 0,
        spendMinorUnits: 0,
      },
      createdAt: '2026-08-05T01:00:00.000Z',
    },
    defaultLimits: {
      requestsPerMinute: 5,
      maxConcurrency: 2,
      quotaUnits: 200,
      spendBudgetMinorUnits: 200,
    },
  })
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, ['RATE_LIMIT'])
  assert.deepEqual(result.scopes.workspace.reasons, ['RATE_LIMIT'])
  assert.deepEqual(result.scopes.client.reasons, [])
  assert.deepEqual(
    JSON.parse(persistedAdmission.workspaceDecisionJson).reasons,
    ['RATE_LIMIT'],
  )
  assert.deepEqual(
    JSON.parse(persistedAdmission.clientDecisionJson).reasons,
    [],
  )
  assert.equal(persistedAlerts.length, 1)
  assert.equal(persistedAlerts[0].scopeType, 'workspace')
})
