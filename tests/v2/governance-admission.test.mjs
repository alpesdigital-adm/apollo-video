import assert from 'node:assert/strict'
import test from 'node:test'

import {
  admitGovernedCapabilityService,
  DEFAULT_GOVERNANCE_ANOMALY_POLICY,
  governanceAnomalyPolicyFromEnvironment,
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
    this.drafts = []
  }

  async admit({ draft, defaultLimits }) {
    this.drafts.push(draft)
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
  assert.equal(DEFAULT_GOVERNANCE_ANOMALY_POLICY.requestMinimum, 100)
  assert.throws(
    () => governanceDefaultLimitsFromEnvironment({
      APOLLO_GOVERNANCE_REQUESTS_PER_MINUTE: '0',
    }),
    /governance default is invalid/,
  )
  assert.throws(
    () => governanceAnomalyPolicyFromEnvironment({
      APOLLO_GOVERNANCE_ANOMALY_ERROR_RATE_BPS: '10001',
    }),
    (error) => error?.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
})

test('F0.103 only an authenticated human administrator receives anomaly recovery authority', async () => {
  const repository = new AdmissionRepository({
    requestsInWindow: 0, activeConcurrency: 0,
    quotaUnitsUsed: 0, spendMinorUnits: 0,
  })
  const admit = admitGovernedCapabilityService({ repository })
  const bearer = actor()
  await admit({
    actor: Object.freeze({
      ...bearer,
      scopes: new Set([...bearer.scopes, 'clients:admin']),
    }),
    capability: {
      id: 'apollo.governance.alerts.list',
      operationKind: 'query', costClass: 'free',
    },
  })
  await admit({
    actor: (() => {
      const auditContext = createExternalAuditContext({
        clientId: bearer.clientId,
        credentialId: bearer.credentialId,
        workspaceId: bearer.workspaceId,
        environment: bearer.environment,
        delegatedUserId: 'human-admin-user',
        delegatedIdentityId: 'human-admin-identity',
        workspaceRole: 'administrator',
      })
      return Object.freeze({
        ...bearer,
        ...auditContext,
        auditContext,
        delegatedUserId: auditContext.delegatedUserId,
        delegatedIdentityId: auditContext.delegatedIdentityId,
        workspaceRole: auditContext.workspaceRole,
      authenticationKind: 'ui-session',
      scopes: new Set([...bearer.scopes, 'clients:admin']),
      })
    })(),
    capability: {
      id: 'apollo.governance.alerts.list',
      operationKind: 'query', costClass: 'free',
    },
  })
  assert.equal(repository.drafts[0].anomalyRecoveryAuthorized, false)
  assert.equal(repository.drafts[1].anomalyRecoveryAuthorized, true)
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
      anomalyPolicy: DEFAULT_GOVERNANCE_ANOMALY_POLICY,
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
    anomalyPolicy: DEFAULT_GOVERNANCE_ANOMALY_POLICY,
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

function anomalyTransaction(evidence) {
  return {
    async $queryRaw() { return [{ pg_advisory_xact_lock: null }] },
    v2GovernancePolicy: { async findMany() { return [] } },
    v2PublicOperation: {
      async count({ where }) {
        if (where.status?.in?.includes('running')) return 0
        if (where.status?.in?.includes('succeeded')) return 10
        if (where.status === 'failed') return 6
        return 0
      },
    },
    v2GovernanceAdmission: {
      async count({ where }) {
        if (where.requestedConcurrency || where.createdAt?.lt) return 0
        return 20
      },
      async aggregate() {
        return { _sum: { requestedQuotaUnits: 0, requestedSpendMinorUnits: 0 } }
      },
      async create({ data }) { evidence.admission = data; return data },
    },
    v2GovernanceAlert: {
      async createMany({ data }) {
        evidence.alerts = data
        return { count: data.length }
      },
    },
  }
}

test('F0.103 Prisma admission atomically blocks request/error anomalies and persists evidence', async () => {
  const evidence = {}
  const transaction = anomalyTransaction(evidence)
  const repository = new PrismaGovernanceAdmissionRepository({
    async $transaction(callback) { return callback(transaction) },
  })
  const result = await repository.admit({
    draft: {
      id: 'governance-admission-anomaly-block',
      workspaceId: 'governance-workspace', clientId: 'governance-client',
      capabilityId: 'apollo.projects.exports.create',
      environment: 'production', operationKind: 'job', costClass: 'free',
      requested: { requests: 1, concurrency: 0, quotaUnits: 0, spendMinorUnits: 0 },
      anomalyRecoveryAuthorized: false,
      createdAt: '2026-08-06T12:00:00.000Z',
    },
    defaultLimits: {
      requestsPerMinute: 1000, maxConcurrency: 100,
      quotaUnits: 10000, spendBudgetMinorUnits: 10000,
    },
    anomalyPolicy: DEFAULT_GOVERNANCE_ANOMALY_POLICY,
  })
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, [
    'REQUEST_RATE_ANOMALY', 'ERROR_RATE_ANOMALY',
  ])
  assert.equal(result.schemaVersion, 'governance-admission/v2')
  assert.equal(evidence.admission.anomalyPolicyHash,
    DEFAULT_GOVERNANCE_ANOMALY_POLICY.policyHash)
  assert.equal(evidence.alerts.length, 4)
  assert.ok(evidence.alerts.every((alert) =>
    alert.schemaVersion === 'governance-alert/v2' &&
    alert.windowStartedAt instanceof Date &&
    alert.windowEndedAt instanceof Date))
})

test('F0.103 human recovery authorization bypasses only anomaly blocking and remains alerted', async () => {
  const evidence = {}
  const transaction = anomalyTransaction(evidence)
  const repository = new PrismaGovernanceAdmissionRepository({
    async $transaction(callback) { return callback(transaction) },
  })
  const result = await repository.admit({
    draft: {
      id: 'governance-admission-anomaly-recovery',
      workspaceId: 'governance-workspace', clientId: 'governance-client',
      capabilityId: 'apollo.governance.alerts.list',
      environment: 'production', operationKind: 'query', costClass: 'free',
      requested: { requests: 1, concurrency: 0, quotaUnits: 0, spendMinorUnits: 0 },
      anomalyRecoveryAuthorized: true,
      createdAt: '2026-08-06T12:00:00.000Z',
    },
    defaultLimits: {
      requestsPerMinute: 1000, maxConcurrency: 100,
      quotaUnits: 10000, spendBudgetMinorUnits: 10000,
    },
    anomalyPolicy: DEFAULT_GOVERNANCE_ANOMALY_POLICY,
  })
  assert.equal(result.allowed, true)
  assert.deepEqual(result.reasons, [])
  assert.equal(result.anomalyRecoveryBypassed, true)
  assert.equal(result.scopes.workspace.anomalies.length, 2)
  assert.equal(evidence.alerts.length, 4)
  assert.ok(evidence.alerts.every((alert) =>
    alert.anomalyRecoveryBypassed === true))
})

test('F0.103 anomaly recovery never bypasses an ordinary governance limit', async () => {
  const evidence = {}
  const transaction = anomalyTransaction(evidence)
  const repository = new PrismaGovernanceAdmissionRepository({
    async $transaction(callback) { return callback(transaction) },
  })
  const result = await repository.admit({
    draft: {
      id: 'governance-admission-limit-during-recovery',
      workspaceId: 'governance-workspace', clientId: 'governance-client',
      capabilityId: 'apollo.governance.alerts.list',
      environment: 'production', operationKind: 'query', costClass: 'free',
      requested: { requests: 1, concurrency: 0, quotaUnits: 0, spendMinorUnits: 0 },
      anomalyRecoveryAuthorized: true,
      createdAt: '2026-08-06T12:00:00.000Z',
    },
    defaultLimits: {
      requestsPerMinute: 20, maxConcurrency: 100,
      quotaUnits: 10000, spendBudgetMinorUnits: 10000,
    },
    anomalyPolicy: DEFAULT_GOVERNANCE_ANOMALY_POLICY,
  })
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, ['RATE_LIMIT'])
  assert.equal(result.anomalyRecoveryBypassed, true)
  assert.ok(evidence.alerts.some((alert) => alert.reasonCode === 'RATE_LIMIT'))
  assert.ok(evidence.alerts.some((alert) =>
    alert.reasonCode === 'ERROR_RATE_ANOMALY' &&
    alert.anomalyRecoveryBypassed === true))
})
