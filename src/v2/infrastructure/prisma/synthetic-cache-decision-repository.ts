import { Prisma, type PrismaClient, type V2SyntheticCacheDecision } from '../../../../generated/prisma-v2/index.js'

import type {
  SyntheticCacheDecisionRepository,
  SyntheticCacheDecisionSummary,
} from '../../application/ports/synthetic-cache-decision-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticCacheDecisionIntegrity,
  assertSyntheticCacheDecisionPrivacy,
  SYNTHETIC_CACHE_DECISION_OUTCOMES,
  SYNTHETIC_CACHE_DECISION_REASON_CODES,
  SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION,
  type SyntheticCacheDecision,
  type SyntheticCacheDecisionOutcome,
  type SyntheticCacheDecisionReasonCode,
} from '../../domain/synthetic-cache-decision.ts'
import { SYNTHETIC_CACHE_OPERATIONS, type SyntheticCacheOperation } from '../../domain/synthetic-cache-identity.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

/**
 * Fail-closed rehydration. Every column is projected back into the aggregate
 * and the content address is recomputed: a row whose amount, outcome or reason
 * was edited behind the application stops verifying, so tampered savings can
 * never be reported as fact.
 */
function hydrate(row: V2SyntheticCacheDecision): Readonly<SyntheticCacheDecision> {
  if (row.schemaVersion !== SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic cache decision has an unknown schema version')
  }
  if (!SYNTHETIC_CACHE_OPERATIONS.includes(row.operation as SyntheticCacheOperation)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic cache decision has an unknown operation')
  }
  if (!SYNTHETIC_CACHE_DECISION_OUTCOMES.includes(row.outcome as SyntheticCacheDecisionOutcome)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic cache decision has an unknown outcome')
  }
  if (!SYNTHETIC_CACHE_DECISION_REASON_CODES.includes(row.reasonCode as SyntheticCacheDecisionReasonCode)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic cache decision has an unknown reason code')
  }
  const decision: SyntheticCacheDecision = {
    schemaVersion: SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    operation: row.operation as SyntheticCacheOperation,
    cacheKey: row.cacheKey,
    cacheKeyVersion: row.cacheKeyVersion,
    outcome: row.outcome as SyntheticCacheDecisionOutcome,
    reasonCode: row.reasonCode as SyntheticCacheDecisionReasonCode,
    reason: row.reason,
    candidateGenerationId: row.candidateGenerationId,
    candidateMasterId: row.candidateMasterId,
    policyVersion: row.policyVersion,
    criticReportHash: row.criticReportHash,
    estimatedSavingMinorUnits: row.estimatedSavingMinorUnits,
    avoidedCostMinorUnits: row.avoidedCostMinorUnits,
    currency: row.currency,
    subjectHash: row.subjectHash,
    decidedAt: row.decidedAt.toISOString(),
    decisionHash: row.decisionHash,
  }
  assertSyntheticCacheDecisionIntegrity(decision)
  assertSyntheticCacheDecisionPrivacy(decision)
  return Object.freeze(decision)
}

function decisionData(decision: Readonly<SyntheticCacheDecision>) {
  return {
    id: decision.id,
    workspaceId: decision.workspaceId,
    projectId: decision.projectId,
    schemaVersion: decision.schemaVersion,
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
    decisionHash: decision.decisionHash,
    decidedAt: new Date(decision.decidedAt),
  }
}

export class PrismaSyntheticCacheDecisionRepository implements SyntheticCacheDecisionRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async record(decision: Readonly<SyntheticCacheDecision>) {
    assertSyntheticCacheDecisionIntegrity(decision)
    assertSyntheticCacheDecisionPrivacy(decision)
    try {
      const row = await this.client.v2SyntheticCacheDecision.create({ data: decisionData(decision) })
      return Object.freeze({ decision: hydrate(row), recorded: true })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The content address is the identity: an identical decision is
        // already booked, so the replay returns it instead of counting its
        // avoided cost a second time.
        const existing = await this.client.v2SyntheticCacheDecision.findUnique({
          where: {
            workspaceId_decisionHash: {
              workspaceId: decision.workspaceId,
              decisionHash: decision.decisionHash,
            },
          },
        })
        if (existing) return Object.freeze({ decision: hydrate(existing), recorded: false })
        throw new DomainError(
          'VERSION_CONFLICT',
          'Synthetic cache decision id already names a different decision',
        )
      }
      throw error
    }
  }

  async listByCacheKey(input: Parameters<SyntheticCacheDecisionRepository['listByCacheKey']>[0]) {
    const rows = await this.client.v2SyntheticCacheDecision.findMany({
      where: { workspaceId: input.workspaceId, cacheKey: input.cacheKey },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }

  async listByProject(input: Parameters<SyntheticCacheDecisionRepository['listByProject']>[0]) {
    const rows = await this.client.v2SyntheticCacheDecision.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }

  async summarize(input: Parameters<SyntheticCacheDecisionRepository['summarize']>[0]) {
    const where = {
      workspaceId: input.workspaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }
    const [outcomes, currencies] = await Promise.all([
      this.client.v2SyntheticCacheDecision.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      this.client.v2SyntheticCacheDecision.groupBy({
        by: ['currency'],
        where,
        _count: { _all: true },
        _sum: { avoidedCostMinorUnits: true, estimatedSavingMinorUnits: true },
      }),
    ])
    const byOutcome = Object.fromEntries(
      SYNTHETIC_CACHE_DECISION_OUTCOMES.map((outcome) => [outcome, 0]),
    ) as Record<SyntheticCacheDecisionOutcome, number>
    for (const entry of outcomes) {
      if (!SYNTHETIC_CACHE_DECISION_OUTCOMES.includes(entry.outcome as SyntheticCacheDecisionOutcome)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic cache decision has an unknown outcome')
      }
      byOutcome[entry.outcome as SyntheticCacheDecisionOutcome] = entry._count._all
    }
    const summary: SyntheticCacheDecisionSummary = {
      byOutcome: Object.freeze(byOutcome),
      byCurrency: Object.freeze(
        [...currencies]
          .sort((left, right) => left.currency.localeCompare(right.currency))
          .map((entry) => Object.freeze({
            currency: entry.currency,
            decisions: entry._count._all,
            avoidedCostMinorUnits: entry._sum.avoidedCostMinorUnits ?? 0,
            estimatedSavingMinorUnits: entry._sum.estimatedSavingMinorUnits ?? 0,
          })),
      ),
    }
    return Object.freeze(summary)
  }
}
