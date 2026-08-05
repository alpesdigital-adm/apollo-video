import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateGovernancePolicyRevision,
  createGovernancePolicy,
  evaluateGovernanceLimits,
} from '../../src/v2/domain/governance-limits.ts'

test('client/workspace governance reserves rate, quota, concurrency and spend together', () => {
  const scope = { workspaceId: 'workspace-1', clientId: 'client-1' }
  const limits = {
    requestsPerMinute: 60,
    maxConcurrency: 4,
    quotaUnits: 1000,
    spendBudgetMinorUnits: 5000,
  }
  const allowed = evaluateGovernanceLimits(
    scope,
    limits,
    {
      requestsInWindow: 10,
      activeConcurrency: 1,
      quotaUnitsUsed: 100,
      spendMinorUnits: 500,
    },
    {
      requests: 1,
      concurrency: 1,
      quotaUnits: 10,
      spendMinorUnits: 100,
    },
  )
  assert.equal(allowed.allowed, true)
  assert.deepEqual(allowed.remaining, {
    requests: 49,
    concurrency: 2,
    quotaUnits: 890,
    spendMinorUnits: 4400,
  })
  const blocked = evaluateGovernanceLimits(
    scope,
    limits,
    {
      requestsInWindow: 60,
      activeConcurrency: 4,
      quotaUnitsUsed: 995,
      spendMinorUnits: 4995,
    },
    { quotaUnits: 10, spendMinorUnits: 10 },
  )
  assert.deepEqual(blocked.reasons, [
    'RATE_LIMIT',
    'CONCURRENCY_LIMIT',
    'QUOTA_EXCEEDED',
    'SPEND_BUDGET_EXCEEDED',
  ])
})

test('stored governance policy revision binds scope, environment and every limit', () => {
  const input = {
    id: 'governance-policy-1',
    workspaceId: 'workspace-1',
    scopeType: 'client',
    scopeId: 'client-1',
    environment: 'production',
    limits: {
      requestsPerMinute: 60,
      maxConcurrency: 4,
      quotaUnits: 1000,
      spendBudgetMinorUnits: 5000,
    },
    updatedByClientId: 'admin-client',
    createdAt: '2026-08-05T01:00:00.000Z',
    updatedAt: '2026-08-05T01:00:00.000Z',
  }
  const policy = createGovernancePolicy(input)
  assert.equal(
    policy.revision,
    calculateGovernancePolicyRevision(input),
  )
  assert.throws(
    () => createGovernancePolicy({ ...input, revision: 'f'.repeat(64) }),
    /revision is invalid/,
  )
})
