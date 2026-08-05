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
  validateGovernanceLimits,
  type GovernanceLimits,
} from '../domain/governance-limits.ts'

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

function configuredLimit(
  value: string | undefined,
  fallback: number,
  field: string,
  minimum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
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

export function admitGovernedCapabilityService(dependencies: {
  repository: GovernanceAdmissionRepository
  defaultLimits?: Readonly<GovernanceLimits>
  clock?: () => Date
  createId?: () => string
}) {
  const defaultLimits = validateGovernanceLimits(
    dependencies.defaultLimits ?? DEFAULT_GOVERNANCE_LIMITS,
  )
  const clock = dependencies.clock ?? (() => new Date())
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
        createdAt,
      },
      defaultLimits,
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
