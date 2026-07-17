import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateGovernanceLimits } from '../../src/v2/domain/governance-limits.ts'

test('client/workspace governance evaluates rate, quota, concurrency and spend together', () => {
  const scope = { workspaceId: 'workspace-1', clientId: 'client-1' }
  const limits = { requestsPerMinute: 60, maxConcurrency: 4, quotaUnits: 1000, spendBudgetMinorUnits: 5000 }
  const allowed = evaluateGovernanceLimits(scope, limits, { requestsInWindow: 10, activeConcurrency: 1, quotaUnitsUsed: 100, spendMinorUnits: 500 }, { quotaUnits: 10, spendMinorUnits: 100 })
  assert.equal(allowed.allowed, true)
  const blocked = evaluateGovernanceLimits(scope, limits, { requestsInWindow: 60, activeConcurrency: 4, quotaUnitsUsed: 995, spendMinorUnits: 4995 }, { quotaUnits: 10, spendMinorUnits: 10 })
  assert.deepEqual(blocked.reasons, ['RATE_LIMIT', 'CONCURRENCY_LIMIT', 'QUOTA_EXCEEDED', 'SPEND_BUDGET_EXCEEDED'])
})
