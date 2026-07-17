import { assertDomain } from './errors.ts'

export interface GovernanceLimits {
  requestsPerMinute: number
  maxConcurrency: number
  quotaUnits: number
  spendBudgetMinorUnits: number
}

export interface GovernanceUsage {
  requestsInWindow: number
  activeConcurrency: number
  quotaUnitsUsed: number
  spendMinorUnits: number
}

export function evaluateGovernanceLimits(scope: { workspaceId: string; clientId: string }, limits: GovernanceLimits, usage: GovernanceUsage, requested: { quotaUnits: number; spendMinorUnits: number }) {
  assertDomain(Boolean(scope.workspaceId && scope.clientId), 'INVALID_ARGUMENT', 'governance scope is required')
  for (const value of [...Object.values(limits), ...Object.values(usage), ...Object.values(requested)]) assertDomain(Number.isInteger(value) && value >= 0, 'INVALID_ARGUMENT', 'governance counters must be non-negative integers')
  assertDomain(limits.requestsPerMinute >= 1 && limits.maxConcurrency >= 1, 'INVALID_ARGUMENT', 'governance limits must allow bounded execution')
  const reasons = [
    ...(usage.requestsInWindow >= limits.requestsPerMinute ? ['RATE_LIMIT'] : []),
    ...(usage.activeConcurrency >= limits.maxConcurrency ? ['CONCURRENCY_LIMIT'] : []),
    ...(usage.quotaUnitsUsed + requested.quotaUnits > limits.quotaUnits ? ['QUOTA_EXCEEDED'] : []),
    ...(usage.spendMinorUnits + requested.spendMinorUnits > limits.spendBudgetMinorUnits ? ['SPEND_BUDGET_EXCEEDED'] : []),
  ]
  return Object.freeze({ workspaceId: scope.workspaceId, clientId: scope.clientId, allowed: reasons.length === 0, reasons: Object.freeze(reasons), remaining: Object.freeze({ requests: Math.max(0, limits.requestsPerMinute - usage.requestsInWindow), concurrency: Math.max(0, limits.maxConcurrency - usage.activeConcurrency), quotaUnits: Math.max(0, limits.quotaUnits - usage.quotaUnitsUsed), spendMinorUnits: Math.max(0, limits.spendBudgetMinorUnits - usage.spendMinorUnits) }) })
}
