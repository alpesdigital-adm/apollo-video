import type { ApiAccessAuditContext } from './api-access-control.ts'
import { assertDomain } from './errors.ts'
import {
  createPublicEvent,
  type PublicEvent,
} from './public-event.ts'
import {
  batchProgress,
  hydrateProductionBatch,
  type ProductionBatch,
} from './production-batch.ts'

export const PRODUCTION_BATCH_BUDGET_THRESHOLD_POLICY_VERSION =
  'production-batch-budget-thresholds/v1' as const

export const PRODUCTION_BATCH_BUDGET_THRESHOLDS = Object.freeze([
  Object.freeze({ basisPoints: 8_000, level: 'warning' as const }),
  Object.freeze({ basisPoints: 10_000, level: 'exhausted' as const }),
])

export function createProductionBatchBudgetThresholdEvents(input: {
  previousBatch: Readonly<ProductionBatch>
  resultingBatch: Readonly<ProductionBatch>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  occurredAt: string
  createEventId: () => string
}): readonly Readonly<PublicEvent>[] {
  const previous = hydrateProductionBatch(input.previousBatch)
  const resulting = hydrateProductionBatch(input.resultingBatch)
  assertDomain(
    previous.id === resulting.id &&
      previous.workspaceId === resulting.workspaceId &&
      previous.projectId === resulting.projectId &&
      previous.budget.currency === resulting.budget.currency &&
      previous.budget.maxCostMinorUnits ===
        resulting.budget.maxCostMinorUnits &&
      input.authenticationAudit.workspaceId === resulting.workspaceId,
    'PERSISTENCE_CONFLICT',
    'Production batch budget threshold transition is not bound to one budget',
  )
  const previousSpentMinorUnits = batchProgress(previous).spentMinorUnits
  const spentMinorUnits = batchProgress(resulting).spentMinorUnits
  const maximumMinorUnits = resulting.budget.maxCostMinorUnits
  assertDomain(
    spentMinorUnits >= previousSpentMinorUnits &&
      spentMinorUnits <= maximumMinorUnits,
    'PERSISTENCE_CONFLICT',
    'Production batch budget consumption must be monotonic and bounded',
  )
  if (
    maximumMinorUnits === 0 ||
    spentMinorUnits === previousSpentMinorUnits
  ) {
    return Object.freeze([])
  }
  const crossed = PRODUCTION_BATCH_BUDGET_THRESHOLDS.filter((threshold) =>
    previousSpentMinorUnits * 10_000 <
      maximumMinorUnits * threshold.basisPoints &&
    spentMinorUnits * 10_000 >=
      maximumMinorUnits * threshold.basisPoints)
  return Object.freeze(crossed.map((threshold) => createPublicEvent({
    id: input.createEventId(),
    type: 'budget.threshold.reached',
    version: '1.0.0',
    workspaceId: resulting.workspaceId,
    occurredAt: input.occurredAt,
    actor: {
      clientId: input.authenticationAudit.clientId,
      ...(input.authenticationAudit.delegatedUserId
        ? { userId: input.authenticationAudit.delegatedUserId }
        : {}),
    },
    resource: {
      type: 'workspace',
      id: resulting.workspaceId,
    },
    data: {
      budgetScope: 'production-batch',
      policyVersion: PRODUCTION_BATCH_BUDGET_THRESHOLD_POLICY_VERSION,
      batchId: resulting.id,
      projectId: resulting.projectId,
      currency: resulting.budget.currency,
      thresholdBasisPoints: threshold.basisPoints,
      thresholdLevel: threshold.level,
      previousSpentMinorUnits,
      spentMinorUnits,
      maximumMinorUnits,
    },
  })))
}
