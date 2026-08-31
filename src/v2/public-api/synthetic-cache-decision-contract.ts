import type { SyntheticCacheDecisionSummary } from '../application/ports/synthetic-cache-decision-repository.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  SYNTHETIC_CACHE_DECISION_OUTCOMES,
  type SyntheticCacheDecision,
  type SyntheticCacheDecisionOutcome,
} from '../domain/synthetic-cache-decision.ts'

/**
 * Public contract for the synthetic cache decision ledger (F3.008).
 *
 * The ledger is evidence, not a copy of the work. Presenters here project an
 * explicit allowlist of fields — never a spread of the aggregate — so a field
 * added to the domain later cannot reach the public surface by accident. What
 * crosses the boundary is digests (`cacheKey`, `subjectHash`,
 * `criticReportHash`), identifiers, the outcome and its reason, the policy in
 * force and the money involved. The script the subject was derived from, the
 * consent evidence and every provider credential stay behind the hash, which
 * is the entire reason the ledger stores hashes in the first place.
 */

const HASH = /^[a-f0-9]{64}$/

function string(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && value.trim().length > 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-empty string`,
  )
  return (value as string).trim()
}

function cacheKey(value: string | null, field: string): string {
  const raw = string(value, field)
  assertDomain(HASH.test(raw), 'INVALID_ARGUMENT', `${field} must be a SHA-256 content address`)
  return raw
}

function outcome(value: string | null, field: string): SyntheticCacheDecisionOutcome {
  const raw = string(value, field)
  assertDomain(
    (SYNTHETIC_CACHE_DECISION_OUTCOMES as readonly string[]).includes(raw),
    'INVALID_ARGUMENT',
    `${field} must be one of ${SYNTHETIC_CACHE_DECISION_OUTCOMES.join(', ')}`,
  )
  return raw as SyntheticCacheDecisionOutcome
}

function boundedLimit(value: string | null, field: string): number {
  const limit = Number(value)
  assertDomain(
    value !== null && value.trim().length > 0 && Number.isSafeInteger(limit),
    'INVALID_ARGUMENT',
    `${field} must be an integer`,
  )
  return limit
}

export const SYNTHETIC_CACHE_DECISION_LIST_QUERY_PARAMETERS: ReadonlySet<string> =
  new Set(['outcome', 'cacheKey', 'limit'])

export function parseSyntheticCacheDecisionListQuery(parameters: URLSearchParams) {
  return Object.freeze({
    ...(parameters.has('outcome') ? { outcome: outcome(parameters.get('outcome'), 'outcome') } : {}),
    ...(parameters.has('cacheKey') ? { cacheKey: cacheKey(parameters.get('cacheKey'), 'cacheKey') } : {}),
    ...(parameters.has('limit') ? { limit: boundedLimit(parameters.get('limit'), 'limit') } : {}),
  }) as Readonly<{
    outcome?: SyntheticCacheDecisionOutcome
    cacheKey?: string
    limit?: number
  }>
}

export const SYNTHETIC_CACHE_DECISION_TRACE_QUERY_PARAMETERS: ReadonlySet<string> =
  new Set(['cacheKey', 'limit'])

/**
 * `cacheKey` is required here: a trace without an address would be a
 * workspace-wide dump of the ledger behind an endpoint whose whole contract is
 * "explain this one unit of work".
 */
export function parseSyntheticCacheDecisionTraceQuery(parameters: URLSearchParams) {
  assertDomain(parameters.has('cacheKey'), 'INVALID_ARGUMENT', 'cacheKey is required')
  return Object.freeze({
    cacheKey: cacheKey(parameters.get('cacheKey'), 'cacheKey'),
    ...(parameters.has('limit') ? { limit: boundedLimit(parameters.get('limit'), 'limit') } : {}),
  }) as Readonly<{ cacheKey: string; limit?: number }>
}

export function presentSyntheticCacheDecision(decision: Readonly<SyntheticCacheDecision>) {
  return Object.freeze({
    schemaVersion: decision.schemaVersion,
    id: decision.id,
    workspaceId: decision.workspaceId,
    projectId: decision.projectId,
    operation: decision.operation,
    cacheKey: decision.cacheKey,
    cacheKeyVersion: decision.cacheKeyVersion,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    candidateGenerationId: decision.candidateGenerationId,
    candidateMasterId: decision.candidateMasterId,
    policyVersion: decision.policyVersion,
    criticReportHash: decision.criticReportHash,
    estimatedSavingMinorUnits: decision.estimatedSavingMinorUnits,
    avoidedCostMinorUnits: decision.avoidedCostMinorUnits,
    currency: decision.currency,
    subjectHash: decision.subjectHash,
    decidedAt: decision.decidedAt,
    decisionHash: decision.decisionHash,
  })
}

/**
 * Savings are reported per currency and never as one scalar. A single total
 * would require an exchange rate nobody supplied, and a number that cannot be
 * reproduced is worse than no number at all.
 */
export function presentSyntheticCacheDecisionSummary(
  summary: Readonly<SyntheticCacheDecisionSummary>,
) {
  return Object.freeze({
    byOutcome: Object.freeze(Object.fromEntries(
      SYNTHETIC_CACHE_DECISION_OUTCOMES.map((name) => [name, summary.byOutcome[name] ?? 0]),
    )),
    byCurrency: summary.byCurrency.map((total) => Object.freeze({
      currency: total.currency,
      decisions: total.decisions,
      avoidedCostMinorUnits: total.avoidedCostMinorUnits,
      estimatedSavingMinorUnits: total.estimatedSavingMinorUnits,
    })),
  })
}
