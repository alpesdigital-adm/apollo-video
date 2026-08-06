import { randomUUID } from 'node:crypto'

import type {
  AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import { materializeActorAuditContext } from './authenticate-api-client.ts'
import type {
  GovernanceAdmissionRepository,
} from './ports/governance-admission-repository.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  GovernanceCostClass,
  GovernanceOperationKind,
} from '../domain/governance-admission.ts'
import {
  MAX_GOVERNANCE_COUNTER,
  validateGovernanceLimits,
  type GovernanceLimits,
} from '../domain/governance-limits.ts'
import {
  createGovernanceAnomalyPolicy,
  type GovernanceAnomalyPolicy,
} from '../domain/governance-anomaly.ts'

const COST_RESERVATIONS = Object.freeze({
  free: Object.freeze({ quotaUnits: 0, spendMinorUnits: 0 }),
  low: Object.freeze({ quotaUnits: 1, spendMinorUnits: 1 }),
  medium: Object.freeze({ quotaUnits: 10, spendMinorUnits: 10 }),
  high: Object.freeze({ quotaUnits: 100, spendMinorUnits: 100 }),
  variable: Object.freeze({ quotaUnits: 100, spendMinorUnits: 100 }),
} satisfies Record<GovernanceCostClass, {
  quotaUnits: number
  spendMinorUnits: number
}>)

export const DEFAULT_GOVERNANCE_LIMITS = Object.freeze({
  requestsPerMinute: 10_000,
  maxConcurrency: 1_000,
  quotaUnits: 1_000_000_000,
  spendBudgetMinorUnits: 1_000_000_000,
})

export const DEFAULT_GOVERNANCE_ANOMALY_POLICY =
  createGovernanceAnomalyPolicy({
    // A cold client has no baseline yet. One editor bootstrap fans out across
    // multiple independent API-first projections, so the initial floor must
    // accommodate a complete page load without disabling baseline detection.
    requestMinimum: 100,
    requestBaselineMultiplierBps: 30_000,
    spendMinimumMinorUnits: 1_000,
    spendBaselineMultiplierBps: 30_000,
    errorMinimumTerminalOperations: 10,
    errorRateThresholdBps: 5_000,
  })

const ANOMALY_RECOVERY_CAPABILITIES = new Set([
  'apollo.governance.alerts.list',
  'apollo.governance.usage-audit.list',
  'apollo.governance.policies.list',
  'apollo.governance.policies.set',
  'apollo.governance.policies.delete',
])

function configuredLimit(
  value: string | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum = MAX_GOVERNANCE_COUNTER,
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      `${field} governance default is invalid`,
    )
  }
  return parsed
}

export function governanceDefaultLimitsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<GovernanceLimits> {
  return validateGovernanceLimits({
    requestsPerMinute: configuredLimit(
      environment.APOLLO_GOVERNANCE_REQUESTS_PER_MINUTE,
      DEFAULT_GOVERNANCE_LIMITS.requestsPerMinute,
      'Request rate',
      1,
    ),
    maxConcurrency: configuredLimit(
      environment.APOLLO_GOVERNANCE_MAX_CONCURRENCY,
      DEFAULT_GOVERNANCE_LIMITS.maxConcurrency,
      'Concurrency',
      1,
    ),
    quotaUnits: configuredLimit(
      environment.APOLLO_GOVERNANCE_QUOTA_UNITS,
      DEFAULT_GOVERNANCE_LIMITS.quotaUnits,
      'Quota',
      0,
    ),
    spendBudgetMinorUnits: configuredLimit(
      environment.APOLLO_GOVERNANCE_SPEND_BUDGET_MINOR_UNITS,
      DEFAULT_GOVERNANCE_LIMITS.spendBudgetMinorUnits,
      'Spend budget',
      0,
    ),
  })
}

export function governanceAnomalyPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<GovernanceAnomalyPolicy> {
  return createGovernanceAnomalyPolicy({
    requestMinimum: configuredLimit(
      environment.APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM,
      DEFAULT_GOVERNANCE_ANOMALY_POLICY.requestMinimum,
      'Request anomaly minimum',
      1,
    ),
    requestBaselineMultiplierBps: configuredLimit(
      environment.APOLLO_GOVERNANCE_ANOMALY_REQUEST_MULTIPLIER_BPS,
      DEFAULT_GOVERNANCE_ANOMALY_POLICY.requestBaselineMultiplierBps,
      'Request anomaly multiplier',
      10_001,
      1_000_000,
    ),
    spendMinimumMinorUnits: configuredLimit(
      environment.APOLLO_GOVERNANCE_ANOMALY_SPEND_MINIMUM_MINOR_UNITS,
      DEFAULT_GOVERNANCE_ANOMALY_POLICY.spendMinimumMinorUnits,
      'Spend anomaly minimum',
      1,
    ),
    spendBaselineMultiplierBps: configuredLimit(
      environment.APOLLO_GOVERNANCE_ANOMALY_SPEND_MULTIPLIER_BPS,
      DEFAULT_GOVERNANCE_ANOMALY_POLICY.spendBaselineMultiplierBps,
      'Spend anomaly multiplier',
      10_001,
      1_000_000,
    ),
    errorMinimumTerminalOperations: configuredLimit(
      environment.APOLLO_GOVERNANCE_ANOMALY_ERROR_MINIMUM_OPERATIONS,
      DEFAULT_GOVERNANCE_ANOMALY_POLICY.errorMinimumTerminalOperations,
      'Error-rate anomaly minimum',
      1,
      1_000_000,
    ),
    errorRateThresholdBps: configuredLimit(
      environment.APOLLO_GOVERNANCE_ANOMALY_ERROR_RATE_BPS,
      DEFAULT_GOVERNANCE_ANOMALY_POLICY.errorRateThresholdBps,
      'Error-rate anomaly threshold',
      1,
      10_000,
    ),
  })
}

export function admitGovernedCapabilityService(dependencies: {
  repository: GovernanceAdmissionRepository
  defaultLimits?: Readonly<GovernanceLimits>
  anomalyPolicy?: Readonly<GovernanceAnomalyPolicy>
  clock?: () => Date
  createId?: () => string
}) {
  const defaultLimits = validateGovernanceLimits(
    dependencies.defaultLimits ?? DEFAULT_GOVERNANCE_LIMITS,
  )
  const clock = dependencies.clock ?? (() => new Date())
  const anomalyPolicy = createGovernanceAnomalyPolicy(
    dependencies.anomalyPolicy ?? DEFAULT_GOVERNANCE_ANOMALY_POLICY,
  )
  const createId = dependencies.createId ??
    (() => `governance-admission-${randomUUID()}`)
  return async function admit(input: {
    actor: AuthenticatedExternalActor
    capability: Readonly<{
      id: string
      operationKind: GovernanceOperationKind
      costClass: GovernanceCostClass
    }>
  }) {
    const audit = materializeActorAuditContext(input.actor)
    const createdAt = clock().toISOString()
    const reservation = COST_RESERVATIONS[input.capability.costClass]
    const anomalyRecoveryAuthorized =
      input.actor.authenticationKind === 'ui-session' &&
      input.actor.scopes.has('clients:admin') &&
      ANOMALY_RECOVERY_CAPABILITIES.has(input.capability.id)
    const admission = await dependencies.repository.admit({
      draft: {
        id: createId(),
        workspaceId: audit.workspaceId,
        clientId: audit.clientId,
        capabilityId: input.capability.id,
        environment: audit.environment,
        operationKind: input.capability.operationKind,
        costClass: input.capability.costClass,
        requested: {
          requests: 1,
          concurrency: input.capability.operationKind === 'job' ? 1 : 0,
          ...reservation,
        },
        anomalyRecoveryAuthorized,
        createdAt,
      },
      defaultLimits,
      anomalyPolicy,
    })
    if (!admission.allowed) {
      throw new DomainError(
        'GOVERNANCE_LIMIT_EXCEEDED',
        'Governance limits rejected the API request',
      )
    }
    return admission
  }
}
