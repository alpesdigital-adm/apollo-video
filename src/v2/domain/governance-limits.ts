import { calculateCanonicalHash } from './canonical-hash.ts'
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

export interface GovernancePolicy {
  id: string
  workspaceId: string
  scopeType: 'workspace' | 'client'
  scopeId: string
  environment: 'sandbox' | 'production'
  limits: Readonly<GovernanceLimits>
  updatedByClientId: string
  createdAt: string
  updatedAt: string
  revision: string
}

export interface GovernanceRequestedUsage {
  requests?: number
  concurrency?: number
  quotaUnits: number
  spendMinorUnits: number
}

export const GOVERNANCE_LIMIT_REASONS = [
  'RATE_LIMIT',
  'CONCURRENCY_LIMIT',
  'QUOTA_EXCEEDED',
  'SPEND_BUDGET_EXCEEDED',
] as const

export type GovernanceLimitReason =
  (typeof GOVERNANCE_LIMIT_REASONS)[number]

export const MAX_GOVERNANCE_COUNTER = 2_000_000_000

function boundedInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 &&
    value <= MAX_GOVERNANCE_COUNTER
}

export function validateGovernanceLimits(
  limits: GovernanceLimits,
): Readonly<GovernanceLimits> {
  assertDomain(
    Object.values(limits).every(boundedInteger) &&
      limits.requestsPerMinute >= 1 &&
      limits.maxConcurrency >= 1,
    'INVALID_ARGUMENT',
    'governance limits must be bounded non-negative integers',
  )
  return Object.freeze({ ...limits })
}

export function calculateGovernancePolicyRevision(input: {
  workspaceId: string
  scopeType: GovernancePolicy['scopeType']
  scopeId: string
  environment: GovernancePolicy['environment']
  limits: Readonly<GovernanceLimits>
}): string {
  return calculateCanonicalHash({
    schemaVersion: 'governance-policy/v1',
    workspaceId: input.workspaceId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    environment: input.environment,
    limits: validateGovernanceLimits(input.limits),
  })
}

export function createGovernancePolicy(
  input: Omit<GovernancePolicy, 'limits' | 'revision'> & {
    limits: GovernanceLimits
    revision?: string
  },
): Readonly<GovernancePolicy> {
  const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
  assertDomain(
    id.test(input.id) && id.test(input.workspaceId) &&
      id.test(input.scopeId) && id.test(input.updatedByClientId) &&
      (input.scopeType === 'workspace' || input.scopeType === 'client') &&
      (input.scopeType !== 'workspace' || input.scopeId === input.workspaceId),
    'INVALID_ARGUMENT',
    'governance policy identity is invalid',
  )
  assertDomain(
    input.environment === 'sandbox' || input.environment === 'production',
    'INVALID_ARGUMENT',
    'governance policy environment is invalid',
  )
  const createdAt = Date.parse(input.createdAt)
  const updatedAt = Date.parse(input.updatedAt)
  assertDomain(
    Number.isFinite(createdAt) && Number.isFinite(updatedAt) &&
      new Date(createdAt).toISOString() === input.createdAt &&
      new Date(updatedAt).toISOString() === input.updatedAt &&
      createdAt <= updatedAt,
    'INVALID_ARGUMENT',
    'governance policy timestamps are invalid',
  )
  const limits = validateGovernanceLimits(input.limits)
  const revision = calculateGovernancePolicyRevision({
    workspaceId: input.workspaceId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    environment: input.environment,
    limits,
  })
  assertDomain(
    input.revision === undefined || input.revision === revision,
    'PERSISTENCE_CONFLICT',
    'governance policy revision is invalid',
  )
  return Object.freeze({ ...input, limits, revision })
}

export function evaluateGovernanceLimits(
  scope: { workspaceId: string; clientId: string },
  limitsInput: GovernanceLimits,
  usage: GovernanceUsage,
  requestedInput: GovernanceRequestedUsage,
) {
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(scope.workspaceId) &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(scope.clientId),
    'INVALID_ARGUMENT',
    'governance scope is required',
  )
  const limits = validateGovernanceLimits(limitsInput)
  const requested = Object.freeze({
    requests: requestedInput.requests ?? 1,
    concurrency: requestedInput.concurrency ?? 1,
    quotaUnits: requestedInput.quotaUnits,
    spendMinorUnits: requestedInput.spendMinorUnits,
  })
  assertDomain(
    [...Object.values(usage), ...Object.values(requested)]
      .every(boundedInteger),
    'INVALID_ARGUMENT',
    'governance counters must be non-negative integers',
  )
  const reasons: GovernanceLimitReason[] = [
    ...(usage.requestsInWindow + requested.requests >
      limits.requestsPerMinute ? ['RATE_LIMIT' as const] : []),
    ...(requested.concurrency > 0 &&
      usage.activeConcurrency + requested.concurrency >
      limits.maxConcurrency ? ['CONCURRENCY_LIMIT' as const] : []),
    ...(requested.quotaUnits > 0 &&
      usage.quotaUnitsUsed + requested.quotaUnits > limits.quotaUnits
      ? ['QUOTA_EXCEEDED' as const]
      : []),
    ...(requested.spendMinorUnits > 0 &&
      usage.spendMinorUnits + requested.spendMinorUnits >
      limits.spendBudgetMinorUnits
      ? ['SPEND_BUDGET_EXCEEDED' as const]
      : []),
  ]
  return Object.freeze({
    workspaceId: scope.workspaceId,
    clientId: scope.clientId,
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    limits,
    usage: Object.freeze({ ...usage }),
    requested,
    remaining: Object.freeze({
      requests: Math.max(
        0,
        limits.requestsPerMinute - usage.requestsInWindow -
          requested.requests,
      ),
      concurrency: Math.max(
        0,
        limits.maxConcurrency - usage.activeConcurrency -
          requested.concurrency,
      ),
      quotaUnits: Math.max(
        0,
        limits.quotaUnits - usage.quotaUnitsUsed - requested.quotaUnits,
      ),
      spendMinorUnits: Math.max(
        0,
        limits.spendBudgetMinorUnits - usage.spendMinorUnits -
          requested.spendMinorUnits,
      ),
    }),
  })
}
