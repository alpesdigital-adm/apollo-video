import { assertDomain } from '../domain/errors.ts'
import type {
  SyntheticCacheDecision,
  SyntheticCacheDecisionOutcome,
} from '../domain/synthetic-cache-decision.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { requireScope } from './authenticate-api-client.ts'
import type {
  SyntheticCacheDecisionRepository,
  SyntheticCacheDecisionSummary,
} from './ports/synthetic-cache-decision-repository.ts'

/**
 * Read-side services over the cache decision ledger.
 *
 * The ledger is the only place where "we did not pay for this again" is
 * written down, so it is exposed read-only and workspace-bound: every service
 * here refuses an actor whose workspace is not the workspace being read, and a
 * decision taken in another workspace is never returned, not even when its
 * cache key is known — the cache key is a content address, and content
 * addresses collide across workspaces by design.
 */

export const SYNTHETIC_CACHE_DECISION_LIST_DEFAULT_LIMIT = 20
export const SYNTHETIC_CACHE_DECISION_LIST_MAX_LIMIT = 100

/**
 * How many of the newest decisions in scope a narrowing filter is applied
 * over. `outcome` and the project check cannot be pushed into the ledger port,
 * so they are applied in memory over a bounded window instead of over an
 * unbounded scan. A caller asking for 20 blocked decisions therefore gets the
 * blocked decisions among the newest 100 — never a page assembled by walking
 * the whole ledger, and never a silent unbounded query.
 */
export const SYNTHETIC_CACHE_DECISION_FILTER_SCAN_WINDOW = SYNTHETIC_CACHE_DECISION_LIST_MAX_LIMIT

function assertReadableWorkspace(actor: AuthenticatedExternalActor, workspaceId: string): void {
  requireScope(actor, 'projects:read')
  assertDomain(
    actor.workspaceId === workspaceId,
    'INVALID_WORKSPACE',
    'Actor cannot read synthetic cache decisions in another workspace',
  )
}

function assertBoundedLimit(limit: number): number {
  assertDomain(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= SYNTHETIC_CACHE_DECISION_LIST_MAX_LIMIT,
    'INVALID_ARGUMENT',
    `limit must be an integer between 1 and ${SYNTHETIC_CACHE_DECISION_LIST_MAX_LIMIT}`,
  )
  return limit
}

export interface ListSyntheticCacheDecisionsRequest {
  workspaceId: string
  projectId: string
  actor: AuthenticatedExternalActor
  outcome?: SyntheticCacheDecisionOutcome
  cacheKey?: string
  limit?: number
}

/**
 * The decisions of one project, newest first.
 *
 * Narrowing by `cacheKey` reads the ledger by its cache address and then keeps
 * only the entries of the requested project: the same address can legitimately
 * have been decided for several projects of the workspace, and a project-scoped
 * path must never widen into its neighbours.
 */
export function listSyntheticCacheDecisionsService(dependencies: {
  decisions: SyntheticCacheDecisionRepository
}) {
  return async function list(
    request: ListSyntheticCacheDecisionsRequest,
  ): Promise<readonly Readonly<SyntheticCacheDecision>[]> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    const limit = assertBoundedLimit(request.limit ?? SYNTHETIC_CACHE_DECISION_LIST_DEFAULT_LIMIT)
    const narrows = Boolean(request.outcome) || Boolean(request.cacheKey)
    const window = narrows ? SYNTHETIC_CACHE_DECISION_FILTER_SCAN_WINDOW : limit
    const page = request.cacheKey
      ? await dependencies.decisions.listByCacheKey({
        workspaceId: request.workspaceId,
        cacheKey: request.cacheKey,
        limit: window,
      })
      : await dependencies.decisions.listByProject({
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        limit: window,
      })
    const matched = page.filter((decision) =>
      decision.projectId === request.projectId &&
      (request.outcome === undefined || decision.outcome === request.outcome))
    return Object.freeze(matched.slice(0, limit))
  }
}

export interface SummarizeSyntheticCacheDecisionsRequest {
  workspaceId: string
  projectId: string
  actor: AuthenticatedExternalActor
}

/**
 * Counts by outcome and money not spent, per accounting currency.
 *
 * The per-currency shape comes straight from the port and is deliberately not
 * collapsed here: summing minor units across currencies would invent an
 * exchange rate the caller cannot reproduce.
 */
export function summarizeSyntheticCacheDecisionsService(dependencies: {
  decisions: SyntheticCacheDecisionRepository
}) {
  return async function summarize(
    request: SummarizeSyntheticCacheDecisionsRequest,
  ): Promise<Readonly<SyntheticCacheDecisionSummary>> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    return await dependencies.decisions.summarize({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
    })
  }
}

export interface TraceSyntheticCacheDecisionsRequest {
  workspaceId: string
  cacheKey: string
  actor: AuthenticatedExternalActor
  limit?: number
}

/**
 * The full trail of one cache address across the workspace, newest first.
 *
 * This is the audit question the ledger exists to answer: why was this exact
 * unit of work reused, regenerated or blocked, and when did that change. It is
 * workspace-wide on purpose — a hit in one project is often explained by a
 * decision taken in another — and workspace-bound for exactly the same reason.
 */
export function traceSyntheticCacheDecisionsService(dependencies: {
  decisions: SyntheticCacheDecisionRepository
}) {
  return async function trace(
    request: TraceSyntheticCacheDecisionsRequest,
  ): Promise<readonly Readonly<SyntheticCacheDecision>[]> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    return await dependencies.decisions.listByCacheKey({
      workspaceId: request.workspaceId,
      cacheKey: request.cacheKey,
      limit: assertBoundedLimit(request.limit ?? SYNTHETIC_CACHE_DECISION_LIST_DEFAULT_LIMIT),
    })
  }
}
