import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { MAX_GOVERNANCE_COUNTER } from './governance-limits.ts'

export const GOVERNANCE_ANOMALY_POLICY_SCHEMA_VERSION =
  'governance-anomaly-policy/v1' as const

export const GOVERNANCE_ANOMALY_REASONS = [
  'REQUEST_RATE_ANOMALY',
  'SPEND_RATE_ANOMALY',
  'ERROR_RATE_ANOMALY',
] as const

export type GovernanceAnomalyReason =
  (typeof GOVERNANCE_ANOMALY_REASONS)[number]

export interface GovernanceAnomalyPolicy {
  schemaVersion: typeof GOVERNANCE_ANOMALY_POLICY_SCHEMA_VERSION
  signalWindowMs: 60_000
  baselineWindowMs: 300_000
  errorWindowMs: 300_000
  requestMinimum: number
  requestBaselineMultiplierBps: number
  spendMinimumMinorUnits: number
  spendBaselineMultiplierBps: number
  errorMinimumTerminalOperations: number
  errorRateThresholdBps: number
  policyHash: string
}

export interface GovernanceAnomalyUsage {
  recentRequests: number
  baselineRequests: number
  recentSpendMinorUnits: number
  baselineSpendMinorUnits: number
  terminalOperations: number
  failedOperations: number
}

export interface GovernanceAnomalyMeasurement {
  reason: GovernanceAnomalyReason
  observed: number
  threshold: number
  windowMs: number
}

const MAX_BPS = 1_000_000

function boundedInteger(value: number, minimum = 0, maximum = MAX_GOVERNANCE_COUNTER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

export function createGovernanceAnomalyPolicy(input: Omit<
  GovernanceAnomalyPolicy,
  'schemaVersion' | 'signalWindowMs' | 'baselineWindowMs' |
    'errorWindowMs' | 'policyHash'
> & { policyHash?: string }): Readonly<GovernanceAnomalyPolicy> {
  assertDomain(
    boundedInteger(input.requestMinimum, 1) &&
      boundedInteger(input.requestBaselineMultiplierBps, 10_001, MAX_BPS) &&
      boundedInteger(input.spendMinimumMinorUnits, 1) &&
      boundedInteger(input.spendBaselineMultiplierBps, 10_001, MAX_BPS) &&
      boundedInteger(input.errorMinimumTerminalOperations, 1, 1_000_000) &&
      boundedInteger(input.errorRateThresholdBps, 1, 10_000),
    'INVALID_ARGUMENT',
    'governance anomaly policy is invalid',
  )
  const content = Object.freeze({
    signalWindowMs: 60_000 as const,
    baselineWindowMs: 300_000 as const,
    errorWindowMs: 300_000 as const,
    requestMinimum: input.requestMinimum,
    requestBaselineMultiplierBps: input.requestBaselineMultiplierBps,
    spendMinimumMinorUnits: input.spendMinimumMinorUnits,
    spendBaselineMultiplierBps: input.spendBaselineMultiplierBps,
    errorMinimumTerminalOperations: input.errorMinimumTerminalOperations,
    errorRateThresholdBps: input.errorRateThresholdBps,
  })
  const policyHash = calculateCanonicalHash({
    schemaVersion: GOVERNANCE_ANOMALY_POLICY_SCHEMA_VERSION,
    ...content,
  })
  assertDomain(
    input.policyHash === undefined || input.policyHash === policyHash,
    'PERSISTENCE_CONFLICT',
    'governance anomaly policy hash is invalid',
  )
  return Object.freeze({
    schemaVersion: GOVERNANCE_ANOMALY_POLICY_SCHEMA_VERSION,
    ...content,
    policyHash,
  })
}

function validateUsage(input: GovernanceAnomalyUsage) {
  assertDomain(
    Object.values(input).every((value) => boundedInteger(value)) &&
      input.failedOperations <= input.terminalOperations,
    'INVALID_ARGUMENT',
    'governance anomaly usage is invalid',
  )
  return Object.freeze({ ...input })
}

function baselineThreshold(
  minimum: number,
  baseline: number,
  multiplierBps: number,
) {
  const baselineMinutes = 5
  return Math.max(
    minimum,
    Math.ceil(baseline * multiplierBps / 10_000 / baselineMinutes),
  )
}

export function evaluateGovernanceAnomalies(input: {
  policy: Readonly<GovernanceAnomalyPolicy>
  usage: GovernanceAnomalyUsage
  requested: Readonly<{ requests: number; spendMinorUnits: number }>
}): readonly Readonly<GovernanceAnomalyMeasurement>[] {
  const policy = createGovernanceAnomalyPolicy(input.policy)
  const usage = validateUsage(input.usage)
  assertDomain(
    boundedInteger(input.requested.requests) &&
      boundedInteger(input.requested.spendMinorUnits),
    'INVALID_ARGUMENT',
    'governance anomaly request is invalid',
  )
  const requestObserved = Math.min(
    MAX_GOVERNANCE_COUNTER,
    usage.recentRequests + input.requested.requests,
  )
  const requestThreshold = baselineThreshold(
    policy.requestMinimum,
    usage.baselineRequests,
    policy.requestBaselineMultiplierBps,
  )
  const spendObserved = Math.min(
    MAX_GOVERNANCE_COUNTER,
    usage.recentSpendMinorUnits + input.requested.spendMinorUnits,
  )
  const spendThreshold = baselineThreshold(
    policy.spendMinimumMinorUnits,
    usage.baselineSpendMinorUnits,
    policy.spendBaselineMultiplierBps,
  )
  const errorRateBps = usage.terminalOperations === 0
    ? 0
    : Math.floor(usage.failedOperations * 10_000 / usage.terminalOperations)
  const measurements: GovernanceAnomalyMeasurement[] = [
    ...(usage.baselineRequests > 0 && requestObserved > requestThreshold
      ? [{
          reason: 'REQUEST_RATE_ANOMALY' as const,
          observed: requestObserved,
          threshold: requestThreshold,
          windowMs: policy.signalWindowMs,
        }]
      : []),
    ...(input.requested.spendMinorUnits > 0 && spendObserved > spendThreshold
      ? [{
          reason: 'SPEND_RATE_ANOMALY' as const,
          observed: spendObserved,
          threshold: spendThreshold,
          windowMs: policy.signalWindowMs,
        }]
      : []),
    ...(usage.terminalOperations >= policy.errorMinimumTerminalOperations &&
      errorRateBps >= policy.errorRateThresholdBps
      ? [{
          reason: 'ERROR_RATE_ANOMALY' as const,
          observed: errorRateBps,
          threshold: policy.errorRateThresholdBps,
          windowMs: policy.errorWindowMs,
        }]
      : []),
  ]
  return Object.freeze(measurements.map((item) => Object.freeze(item)))
}
