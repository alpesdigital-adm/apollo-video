import {
  Prisma,
  type PrismaClient,
  type V2GovernanceAdmission,
  type V2GovernanceAlert,
  type V2GovernancePolicy,
} from '../../../../generated/prisma-v2/index.js'

import type {
  GovernanceAdmissionListQuery,
  GovernanceAlertListQuery,
  GovernanceAdmissionRepository,
  GovernanceAdmissionDraft,
} from '../../application/ports/governance-admission-repository.ts'
import {
  createGovernanceAdmission,
  GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2,
  type GovernanceAdmission,
  type GovernanceDecisionReason,
  type GovernanceAdmissionScopeDecision,
} from '../../domain/governance-admission.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  evaluateGovernanceAnomalies,
  type GovernanceAnomalyMeasurement,
  type GovernanceAnomalyPolicy,
  type GovernanceAnomalyUsage,
} from '../../domain/governance-anomaly.ts'
import {
  createGovernanceAlert,
  GOVERNANCE_ALERT_SCHEMA_VERSION_V2,
  type GovernanceAlert,
} from '../../domain/governance-alert.ts'
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

function isCanonicalInstant(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
}

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
      schemaVersion: row.schemaVersion as GovernanceAdmission['schemaVersion'],
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
      ...(row.anomalyPolicyHash
        ? { anomalyPolicyHash: row.anomalyPolicyHash }
        : {}),
      anomalyRecoveryBypassed: row.anomalyRecoveryBypassed,
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

function hydrateAlert(
  row: V2GovernanceAlert & {
    admission: Readonly<{ admissionHash: string }>
  },
): Readonly<GovernanceAlert> {
  try {
    return createGovernanceAlert({
      schemaVersion: row.schemaVersion as GovernanceAlert['schemaVersion'],
      alertHash: row.alertHash,
      workspaceId: row.workspaceId,
      clientId: row.clientId,
      admissionId: row.admissionId,
      admissionHash: row.admission.admissionHash,
      scopeType: row.scopeType as GovernanceAlert['scopeType'],
      reasonCode: row.reasonCode as GovernanceAlert['reasonCode'],
      observed: row.observed,
      threshold: row.threshold,
      ...(row.policyHash ? { policyHash: row.policyHash } : {}),
      ...(row.schemaVersion === GOVERNANCE_ALERT_SCHEMA_VERSION_V2
        ? { anomalyRecoveryBypassed: row.anomalyRecoveryBypassed }
        : {}),
      ...(row.windowStartedAt
        ? { windowStartedAt: row.windowStartedAt.toISOString() }
        : {}),
      ...(row.windowEndedAt
        ? { windowEndedAt: row.windowEndedAt.toISOString() }
        : {}),
      createdAt: row.createdAt.toISOString(),
    })
  } catch (error) {
    if (
      error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT'
    ) throw error
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored governance alert is invalid',
    )
  }
}

function scopeDecision(
  decision: ReturnType<typeof evaluateGovernanceLimits>,
  anomalies: readonly Readonly<GovernanceAnomalyMeasurement>[],
  anomalyRecoveryBypassed: boolean,
): Readonly<GovernanceAdmissionScopeDecision> {
  return Object.freeze({
    reasons: Object.freeze([
      ...decision.reasons,
      ...(anomalyRecoveryBypassed
        ? []
        : anomalies.map((item) => item.reason)),
    ]),
    anomalies,
    limits: decision.limits,
    usage: decision.usage,
    remaining: decision.remaining,
  })
}

function alertMeasurement(
  scope: Readonly<GovernanceAdmissionScopeDecision>,
  requested: GovernanceAdmission['requested'],
  reason: GovernanceLimitReason,
): Readonly<{ observed: number; threshold: number; windowMs: number }> {
  const observed = (left: number, right: number) =>
    Math.min(MAX_GOVERNANCE_COUNTER, left + right)
  if (reason === 'RATE_LIMIT') {
    return {
      observed: observed(scope.usage.requestsInWindow, requested.requests),
      threshold: scope.limits.requestsPerMinute,
      windowMs: 60_000,
    }
  }
  if (reason === 'CONCURRENCY_LIMIT') {
    return {
      observed: observed(
        scope.usage.activeConcurrency,
        requested.concurrency,
      ),
      threshold: scope.limits.maxConcurrency,
      windowMs: CONCURRENCY_RESERVATION_MS,
    }
  }
  if (reason === 'QUOTA_EXCEEDED') {
    return {
      observed: observed(scope.usage.quotaUnitsUsed, requested.quotaUnits),
      threshold: scope.limits.quotaUnits,
      windowMs: QUOTA_WINDOW_MS,
    }
  }
  return {
    observed: observed(scope.usage.spendMinorUnits, requested.spendMinorUnits),
    threshold: scope.limits.spendBudgetMinorUnits,
    windowMs: QUOTA_WINDOW_MS,
  }
}

function anomalyUsage(input: GovernanceAnomalyUsage) {
  return Object.freeze(input)
}

function alertRow(
  alert: Readonly<GovernanceAlert>,
) {
  return {
    alertHash: alert.alertHash,
    schemaVersion: alert.schemaVersion,
    workspaceId: alert.workspaceId,
    clientId: alert.clientId,
    admissionId: alert.admissionId,
    scopeType: alert.scopeType,
    reasonCode: alert.reasonCode,
    observed: alert.observed,
    threshold: alert.threshold,
    policyHash: alert.policyHash,
    anomalyRecoveryBypassed: alert.anomalyRecoveryBypassed ?? false,
    windowStartedAt: alert.windowStartedAt
      ? new Date(alert.windowStartedAt)
      : null,
    windowEndedAt: alert.windowEndedAt
      ? new Date(alert.windowEndedAt)
      : null,
    createdAt: new Date(alert.createdAt),
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
    anomalyPolicy: Readonly<GovernanceAnomalyPolicy>
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
        const anomalyBaselineStart = new Date(
          requestWindowStart.getTime() - input.anomalyPolicy.baselineWindowMs,
        )
        const errorWindowStart = new Date(
          createdAt.getTime() - input.anomalyPolicy.errorWindowMs,
        )
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
          workspaceBaselineRequests,
          clientBaselineRequests,
          workspaceRecentSpend,
          clientRecentSpend,
          workspaceBaselineSpend,
          clientBaselineSpend,
          workspaceTerminalOperations,
          clientTerminalOperations,
          workspaceFailedOperations,
          clientFailedOperations,
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
              actorEnvironment: draft.environment,
              status: { in: ['running', 'waiting', 'retrying'] },
            },
          }),
          transaction.v2PublicOperation.count({
            where: {
              workspaceId: draft.workspaceId,
              clientId: draft.clientId,
              actorEnvironment: draft.environment,
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
          transaction.v2GovernanceAdmission.count({
            where: {
              ...commonAdmission,
              createdAt: {
                gte: anomalyBaselineStart,
                lt: requestWindowStart,
              },
            },
          }),
          transaction.v2GovernanceAdmission.count({
            where: {
              ...clientAdmission,
              createdAt: {
                gte: anomalyBaselineStart,
                lt: requestWindowStart,
              },
            },
          }),
          transaction.v2GovernanceAdmission.aggregate({
            where: {
              ...commonAdmission,
              allowed: true,
              createdAt: { gte: requestWindowStart },
            },
            _sum: { requestedSpendMinorUnits: true },
          }),
          transaction.v2GovernanceAdmission.aggregate({
            where: {
              ...clientAdmission,
              allowed: true,
              createdAt: { gte: requestWindowStart },
            },
            _sum: { requestedSpendMinorUnits: true },
          }),
          transaction.v2GovernanceAdmission.aggregate({
            where: {
              ...commonAdmission,
              allowed: true,
              createdAt: {
                gte: anomalyBaselineStart,
                lt: requestWindowStart,
              },
            },
            _sum: { requestedSpendMinorUnits: true },
          }),
          transaction.v2GovernanceAdmission.aggregate({
            where: {
              ...clientAdmission,
              allowed: true,
              createdAt: {
                gte: anomalyBaselineStart,
                lt: requestWindowStart,
              },
            },
            _sum: { requestedSpendMinorUnits: true },
          }),
          transaction.v2PublicOperation.count({
            where: {
              workspaceId: draft.workspaceId,
              actorEnvironment: draft.environment,
              status: { in: ['succeeded', 'failed'] },
              completedAt: { gte: errorWindowStart },
            },
          }),
          transaction.v2PublicOperation.count({
            where: {
              workspaceId: draft.workspaceId,
              clientId: draft.clientId,
              actorEnvironment: draft.environment,
              status: { in: ['succeeded', 'failed'] },
              completedAt: { gte: errorWindowStart },
            },
          }),
          transaction.v2PublicOperation.count({
            where: {
              workspaceId: draft.workspaceId,
              actorEnvironment: draft.environment,
              status: 'failed',
              completedAt: { gte: errorWindowStart },
            },
          }),
          transaction.v2PublicOperation.count({
            where: {
              workspaceId: draft.workspaceId,
              clientId: draft.clientId,
              actorEnvironment: draft.environment,
              status: 'failed',
              completedAt: { gte: errorWindowStart },
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
        const workspaceAnomalies = evaluateGovernanceAnomalies({
          policy: input.anomalyPolicy,
          usage: anomalyUsage({
            recentRequests: workspaceRequests,
            baselineRequests: workspaceBaselineRequests,
            recentSpendMinorUnits:
              workspaceRecentSpend._sum.requestedSpendMinorUnits ?? 0,
            baselineSpendMinorUnits:
              workspaceBaselineSpend._sum.requestedSpendMinorUnits ?? 0,
            terminalOperations: workspaceTerminalOperations,
            failedOperations: workspaceFailedOperations,
          }),
          requested: draft.requested,
        })
        const clientAnomalies = evaluateGovernanceAnomalies({
          policy: input.anomalyPolicy,
          usage: anomalyUsage({
            recentRequests: clientRequests,
            baselineRequests: clientBaselineRequests,
            recentSpendMinorUnits:
              clientRecentSpend._sum.requestedSpendMinorUnits ?? 0,
            baselineSpendMinorUnits:
              clientBaselineSpend._sum.requestedSpendMinorUnits ?? 0,
            terminalOperations: clientTerminalOperations,
            failedOperations: clientFailedOperations,
          }),
          requested: draft.requested,
        })
        const anomalyRecoveryBypassed = draft.anomalyRecoveryAuthorized &&
          (workspaceAnomalies.length > 0 || clientAnomalies.length > 0)
        const scopes = Object.freeze({
          workspace: scopeDecision(
            workspaceDecision,
            workspaceAnomalies,
            anomalyRecoveryBypassed,
          ),
          client: scopeDecision(
            clientDecision,
            clientAnomalies,
            anomalyRecoveryBypassed,
          ),
        })
        const reasonOrder: readonly GovernanceDecisionReason[] = [
          ...GOVERNANCE_LIMIT_REASONS,
          'REQUEST_RATE_ANOMALY',
          'SPEND_RATE_ANOMALY',
          'ERROR_RATE_ANOMALY',
        ]
        const reasons = Object.freeze(reasonOrder.filter((reason) =>
          scopes.workspace.reasons.includes(reason) ||
            scopes.client.reasons.includes(reason)))
        const admission = createGovernanceAdmission({
          schemaVersion: GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2,
          id: draft.id,
          workspaceId: draft.workspaceId,
          clientId: draft.clientId,
          capabilityId: draft.capabilityId,
          environment: draft.environment,
          operationKind: draft.operationKind,
          costClass: draft.costClass,
          allowed: reasons.length === 0,
          reasons,
          scopes,
          requested: clientDecision.requested,
          anomalyPolicyHash: input.anomalyPolicy.policyHash,
          anomalyRecoveryBypassed,
          createdAt: draft.createdAt,
        })
        await transaction.v2GovernanceAdmission.create({
          data: {
            id: admission.id,
            schemaVersion: admission.schemaVersion,
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
            anomalyPolicyHash: admission.anomalyPolicyHash,
            anomalyRecoveryBypassed:
              admission.anomalyRecoveryBypassed ?? false,
            admissionHash: admission.admissionHash,
            createdAt,
          },
        })
        const alerts = (['workspace', 'client'] as const).flatMap(
          (scopeType) => {
            const scope = admission.scopes[scopeType]
            const limits = scope.reasons.filter((reason) =>
              GOVERNANCE_LIMIT_REASONS.includes(reason as never))
              .map((reason) => ({
                reason,
                ...alertMeasurement(
                  scope,
                  admission.requested,
                  reason as GovernanceLimitReason,
                ),
                anomalyRecoveryBypassed: false,
              }))
            const anomalies = (scope.anomalies ?? []).map((measurement) => ({
              ...measurement,
              anomalyRecoveryBypassed,
            }))
            return [...limits, ...anomalies].map((measurement) =>
              alertRow(createGovernanceAlert({
                schemaVersion: GOVERNANCE_ALERT_SCHEMA_VERSION_V2,
                workspaceId: admission.workspaceId,
                clientId: admission.clientId,
                admissionId: admission.id,
                admissionHash: admission.admissionHash,
                scopeType,
                reasonCode: measurement.reason,
                observed: measurement.observed,
                threshold: measurement.threshold,
                policyHash: input.anomalyPolicy.policyHash,
                anomalyRecoveryBypassed:
                  measurement.anomalyRecoveryBypassed,
                windowStartedAt: new Date(
                  createdAt.getTime() - measurement.windowMs,
                ).toISOString(),
                windowEndedAt: admission.createdAt,
                createdAt: admission.createdAt,
              })))
          },
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
        !isCanonicalInstant(input.after.createdAt)))
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

  async listAlerts(
    input: GovernanceAlertListQuery,
  ): Promise<readonly Readonly<GovernanceAlert>[]> {
    if (
      !ID.test(input.workspaceId) || !Number.isSafeInteger(input.limit) ||
      input.limit < 1 || input.limit > 101 ||
      (input.after && (
        !/^[a-f0-9]{64}$/.test(input.after.alertHash) ||
        !isCanonicalInstant(input.after.createdAt)
      ))
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Governance alert list query is invalid',
      )
    }
    const after = input.after
    const rows = await this.client.v2GovernanceAlert.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after.createdAt) } },
                {
                  createdAt: new Date(after.createdAt),
                  alertHash: { lt: after.alertHash },
                },
              ],
            }
          : {}),
      },
      include: { admission: { select: { admissionHash: true } } },
      orderBy: [{ createdAt: 'desc' }, { alertHash: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateAlert))
  }
}
