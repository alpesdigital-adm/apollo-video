import {
  Prisma,
  type PrismaClient,
  type V2GovernanceAdmission,
  type V2GovernancePolicy,
} from '../../../../generated/prisma-v2/index.js'

import type {
  GovernanceAdmissionListQuery,
  GovernanceAdmissionRepository,
  GovernanceAdmissionDraft,
} from '../../application/ports/governance-admission-repository.ts'
import {
  createGovernanceAdmission,
  type GovernanceAdmission,
  type GovernanceAdmissionScopeDecision,
} from '../../domain/governance-admission.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createGovernancePolicy,
  evaluateGovernanceLimits,
  GOVERNANCE_LIMIT_REASONS,
  MAX_GOVERNANCE_COUNTER,
  type GovernanceLimitReason,
  type GovernanceLimits,
} from '../../domain/governance-limits.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const CONCURRENCY_RESERVATION_MS = 30_000
const QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

export function hydrateGovernancePolicy(row: V2GovernancePolicy) {
  return createGovernancePolicy({
    id: row.id,
    workspaceId: row.workspaceId,
    scopeType: row.scopeType as 'workspace' | 'client',
    scopeId: row.scopeId,
    environment: row.environment as 'sandbox' | 'production',
    limits: {
      requestsPerMinute: row.requestsPerMinute,
      maxConcurrency: row.maxConcurrency,
      quotaUnits: row.quotaUnits,
      spendBudgetMinorUnits: row.spendBudgetMinorUnits,
    },
    updatedByClientId: row.updatedByClientId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
  })
}

function effectiveLimits(
  defaults: Readonly<GovernanceLimits>,
  rows: readonly V2GovernancePolicy[],
  scopeType: 'workspace' | 'client',
): Readonly<GovernanceLimits> {
  const values = [
    defaults,
    ...rows.filter((row) => row.scopeType === scopeType)
      .map(hydrateGovernancePolicy)
      .map((policy) => policy.limits),
  ]
  return Object.freeze({
    requestsPerMinute: Math.min(...values.map((item) =>
      item.requestsPerMinute)),
    maxConcurrency: Math.min(...values.map((item) =>
      item.maxConcurrency)),
    quotaUnits: Math.min(...values.map((item) => item.quotaUnits)),
    spendBudgetMinorUnits: Math.min(...values.map((item) =>
      item.spendBudgetMinorUnits)),
  })
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored governance admission ${field} is invalid`,
    )
  }
}

function hydrateAdmission(
  row: V2GovernanceAdmission,
): Readonly<GovernanceAdmission> {
  try {
    return createGovernanceAdmission({
      id: row.id,
      workspaceId: row.workspaceId,
      clientId: row.clientId,
      capabilityId: row.capabilityId,
      environment: row.environment as GovernanceAdmission['environment'],
      operationKind: row.operationKind as GovernanceAdmission['operationKind'],
      costClass: row.costClass as GovernanceAdmission['costClass'],
      allowed: row.allowed,
      reasons: parseJson(row.reasonsJson, 'reasons') as GovernanceLimitReason[],
      scopes: {
        workspace: parseJson(
          row.workspaceDecisionJson,
          'workspace decision',
        ) as GovernanceAdmissionScopeDecision,
        client: parseJson(
          row.clientDecisionJson,
          'client decision',
        ) as GovernanceAdmissionScopeDecision,
      },
      requested: {
        requests: row.requestedRequests,
        concurrency: row.requestedConcurrency,
        quotaUnits: row.requestedQuotaUnits,
        spendMinorUnits: row.requestedSpendMinorUnits,
      },
      createdAt: row.createdAt.toISOString(),
      admissionHash: row.admissionHash,
    })
  } catch (error) {
    if (
      error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT'
    ) throw error
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored governance admission is invalid',
    )
  }
}

function scopeDecision(
  decision: ReturnType<typeof evaluateGovernanceLimits>,
): Readonly<GovernanceAdmissionScopeDecision> {
  return Object.freeze({
    reasons: decision.reasons,
    limits: decision.limits,
    usage: decision.usage,
    remaining: decision.remaining,
  })
}

function alertMeasurement(
  scope: Readonly<GovernanceAdmissionScopeDecision>,
  requested: GovernanceAdmission['requested'],
  reason: GovernanceLimitReason,
): Readonly<{ observed: number; threshold: number }> {
  const observed = (left: number, right: number) =>
    Math.min(MAX_GOVERNANCE_COUNTER, left + right)
  if (reason === 'RATE_LIMIT') {
    return {
      observed: observed(scope.usage.requestsInWindow, requested.requests),
      threshold: scope.limits.requestsPerMinute,
    }
  }
  if (reason === 'CONCURRENCY_LIMIT') {
    return {
      observed: observed(
        scope.usage.activeConcurrency,
        requested.concurrency,
      ),
      threshold: scope.limits.maxConcurrency,
    }
  }
  if (reason === 'QUOTA_EXCEEDED') {
    return {
      observed: observed(scope.usage.quotaUnitsUsed, requested.quotaUnits),
      threshold: scope.limits.quotaUnits,
    }
  }
  return {
    observed: observed(scope.usage.spendMinorUnits, requested.spendMinorUnits),
    threshold: scope.limits.spendBudgetMinorUnits,
  }
}

export class PrismaGovernanceAdmissionRepository
implements GovernanceAdmissionRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async admit(input: {
    draft: Readonly<GovernanceAdmissionDraft>
    defaultLimits: Readonly<GovernanceLimits>
  }, serializationAttempt = 1): Promise<Readonly<GovernanceAdmission>> {
    const { draft } = input
    if (!ID.test(draft.workspaceId) || !ID.test(draft.clientId)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Governance admission scope is invalid',
      )
    }
    const createdAt = new Date(draft.createdAt)
    try {
      return await this.client.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${draft.workspaceId}:governance:${draft.environment}`}, 0)
          )
        `)
        const policies = await transaction.v2GovernancePolicy.findMany({
          where: {
            workspaceId: draft.workspaceId,
            environment: draft.environment,
            OR: [
              { scopeType: 'workspace', scopeId: draft.workspaceId },
              { scopeType: 'client', scopeId: draft.clientId },
            ],
          },
        })
        const workspaceLimits = effectiveLimits(
          input.defaultLimits,
          policies,
          'workspace',
        )
        const clientLimits = effectiveLimits(
          input.defaultLimits,
          policies,
          'client',
        )
        const requestWindowStart = new Date(createdAt.getTime() - 60_000)
        const quotaWindowStart = new Date(
          createdAt.getTime() - QUOTA_WINDOW_MS,
        )
        const reservationStart = new Date(
          createdAt.getTime() - CONCURRENCY_RESERVATION_MS,
        )
        const commonAdmission = {
          workspaceId: draft.workspaceId,
          environment: draft.environment,
        }
        const clientAdmission = {
          ...commonAdmission,
          clientId: draft.clientId,
        }
        const [
          workspaceRequests,
          clientRequests,
          workspaceActiveOperations,
          clientActiveOperations,
          workspaceReservations,
          clientReservations,
          workspaceUsage,
          clientUsage,
        ] = await Promise.all([
          transaction.v2GovernanceAdmission.count({
            where: {
              ...commonAdmission,
              createdAt: { gte: requestWindowStart },
            },
          }),
          transaction.v2GovernanceAdmission.count({
            where: {
              ...clientAdmission,
              createdAt: { gte: requestWindowStart },
            },
          }),
          transaction.v2PublicOperation.count({
            where: {
              workspaceId: draft.workspaceId,
              status: { in: ['running', 'waiting', 'retrying'] },
            },
          }),
          transaction.v2PublicOperation.count({
            where: {
              workspaceId: draft.workspaceId,
              clientId: draft.clientId,
              status: { in: ['running', 'waiting', 'retrying'] },
            },
          }),
          transaction.v2GovernanceAdmission.count({
            where: {
              ...commonAdmission,
              allowed: true,
              requestedConcurrency: { gt: 0 },
              createdAt: { gte: reservationStart },
            },
          }),
          transaction.v2GovernanceAdmission.count({
            where: {
              ...clientAdmission,
              allowed: true,
              requestedConcurrency: { gt: 0 },
              createdAt: { gte: reservationStart },
            },
          }),
          transaction.v2GovernanceAdmission.aggregate({
            where: {
              ...commonAdmission,
              allowed: true,
              createdAt: { gte: quotaWindowStart },
            },
            _sum: {
              requestedQuotaUnits: true,
              requestedSpendMinorUnits: true,
            },
          }),
          transaction.v2GovernanceAdmission.aggregate({
            where: {
              ...clientAdmission,
              allowed: true,
              createdAt: { gte: quotaWindowStart },
            },
            _sum: {
              requestedQuotaUnits: true,
              requestedSpendMinorUnits: true,
            },
          }),
        ])
        const workspaceDecision = evaluateGovernanceLimits(
          { workspaceId: draft.workspaceId, clientId: draft.clientId },
          workspaceLimits,
          {
            requestsInWindow: workspaceRequests,
            activeConcurrency: Math.max(
              workspaceActiveOperations,
              workspaceReservations,
            ),
            quotaUnitsUsed: workspaceUsage._sum.requestedQuotaUnits ?? 0,
            spendMinorUnits: workspaceUsage._sum.requestedSpendMinorUnits ?? 0,
          },
          draft.requested,
        )
        const clientDecision = evaluateGovernanceLimits(
          { workspaceId: draft.workspaceId, clientId: draft.clientId },
          clientLimits,
          {
            requestsInWindow: clientRequests,
            activeConcurrency: Math.max(
              clientActiveOperations,
              clientReservations,
            ),
            quotaUnitsUsed: clientUsage._sum.requestedQuotaUnits ?? 0,
            spendMinorUnits: clientUsage._sum.requestedSpendMinorUnits ?? 0,
          },
          draft.requested,
        )
        const scopes = Object.freeze({
          workspace: scopeDecision(workspaceDecision),
          client: scopeDecision(clientDecision),
        })
        const reasons = Object.freeze(GOVERNANCE_LIMIT_REASONS.filter(
          (reason) => scopes.workspace.reasons.includes(reason) ||
            scopes.client.reasons.includes(reason),
        ))
        const admission = createGovernanceAdmission({
          ...draft,
          allowed: reasons.length === 0,
          reasons,
          scopes,
          requested: clientDecision.requested,
        })
        await transaction.v2GovernanceAdmission.create({
          data: {
            id: admission.id,
            workspaceId: admission.workspaceId,
            clientId: admission.clientId,
            capabilityId: admission.capabilityId,
            environment: admission.environment,
            operationKind: admission.operationKind,
            costClass: admission.costClass,
            allowed: admission.allowed,
            reasonsJson: JSON.stringify(admission.reasons),
            workspaceDecisionJson: JSON.stringify(admission.scopes.workspace),
            clientDecisionJson: JSON.stringify(admission.scopes.client),
            requestedRequests: admission.requested.requests,
            requestedConcurrency: admission.requested.concurrency,
            requestedQuotaUnits: admission.requested.quotaUnits,
            requestedSpendMinorUnits: admission.requested.spendMinorUnits,
            admissionHash: admission.admissionHash,
            createdAt,
          },
        })
        const alerts = (['workspace', 'client'] as const).flatMap(
          (scopeType) => admission.scopes[scopeType].reasons.map((reason) => {
            const measurement = alertMeasurement(
              admission.scopes[scopeType],
              admission.requested,
              reason,
            )
            return {
              alertHash: calculateCanonicalHash({
                schemaVersion: 'governance-alert/v1',
                admissionHash: admission.admissionHash,
                scopeType,
                reason,
                ...measurement,
              }),
              workspaceId: admission.workspaceId,
              clientId: admission.clientId,
              admissionId: admission.id,
              scopeType,
              reasonCode: reason,
              ...measurement,
              createdAt,
            }
          }),
        )
        if (alerts.length > 0) {
          await transaction.v2GovernanceAlert.createMany({
            data: alerts,
            skipDuplicates: true,
          })
        }
        return admission
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (
        typeof error === 'object' && error !== null && 'code' in error &&
        error.code === 'P2034'
      ) {
        if (serializationAttempt < 3) {
          return this.admit(input, serializationAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Governance admission collided with a concurrent request',
        )
      }
      throw error
    }
  }

  async list(
    input: GovernanceAdmissionListQuery,
  ): Promise<readonly Readonly<GovernanceAdmission>[]> {
    if (
      !ID.test(input.workspaceId) || !Number.isSafeInteger(input.limit) ||
      input.limit < 1 || input.limit > 101 ||
      (input.after && (!ID.test(input.after.id) ||
        new Date(input.after.createdAt).toISOString() !== input.after.createdAt))
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Governance admission list query is invalid',
      )
    }
    const after = input.after
    const rows = await this.client.v2GovernanceAdmission.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after.createdAt) } },
                {
                  createdAt: new Date(after.createdAt),
                  id: { lt: after.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateAdmission))
  }
}
