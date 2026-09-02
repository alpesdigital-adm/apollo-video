import type {
  SyntheticCacheDecision,
  SyntheticCacheDecisionOutcome,
} from '../../domain/synthetic-cache-decision.ts'

/**
 * Savings accumulated per accounting currency.
 *
 * The summary deliberately refuses to collapse currencies into a single scalar
 * total: adding minor units across currencies would silently invent an
 * exchange rate, and a savings figure nobody can reproduce is worse than no
 * figure at all. Callers that only ever price in one currency read the single
 * entry they get back.
 */
export interface SyntheticCacheDecisionCurrencyTotal {
  currency: string
  decisions: number
  avoidedCostMinorUnits: number
  estimatedSavingMinorUnits: number
}

export interface SyntheticCacheDecisionSummary {
  byOutcome: Readonly<Record<SyntheticCacheDecisionOutcome, number>>
  byCurrency: readonly Readonly<SyntheticCacheDecisionCurrencyTotal>[]
}

export interface SyntheticCacheDecisionRepository {
  /**
   * Appends one decision to the ledger, idempotently by `decisionHash`.
   *
   * Replaying the same decision must never add a second row: the economy this
   * ledger reports is only trustworthy if a retried ensure pass cannot count
   * the same avoided cost twice. `recorded` is false when the entry was
   * already there.
   */
  record(decision: Readonly<SyntheticCacheDecision>): Promise<Readonly<{
    decision: Readonly<SyntheticCacheDecision>
    recorded: boolean
  }>>

  /** Every decision taken about one cache address, newest first. */
  listByCacheKey(input: {
    workspaceId: string
    cacheKey: string
    limit: number
  }): Promise<readonly Readonly<SyntheticCacheDecision>[]>

  listByProject(input: {
    workspaceId: string
    projectId: string
    limit: number
  }): Promise<readonly Readonly<SyntheticCacheDecision>[]>

  summarize(input: {
    workspaceId: string
    projectId?: string
  }): Promise<Readonly<SyntheticCacheDecisionSummary>>
}
