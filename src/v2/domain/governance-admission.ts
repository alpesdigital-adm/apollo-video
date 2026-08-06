import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  GOVERNANCE_LIMIT_REASONS,
  MAX_GOVERNANCE_COUNTER,
  validateGovernanceLimits,
  type GovernanceLimitReason,
  type GovernanceLimits,
  type GovernanceRequestedUsage,
  type GovernanceUsage,
} from './governance-limits.ts'
import {
  GOVERNANCE_ANOMALY_REASONS,
  type GovernanceAnomalyMeasurement,
  type GovernanceAnomalyReason,
} from './governance-anomaly.ts'

export const GOVERNANCE_ADMISSION_SCHEMA_VERSION =
  'governance-admission/v1' as const
export const GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2 =
  'governance-admission/v2' as const

export type GovernanceAdmissionSchemaVersion =
  | typeof GOVERNANCE_ADMISSION_SCHEMA_VERSION
  | typeof GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2

export type GovernanceDecisionReason =
  | GovernanceLimitReason
  | GovernanceAnomalyReason

export const GOVERNANCE_COST_CLASSES = [
  'free',
  'low',
  'medium',
  'high',
  'variable',
] as const

export type GovernanceCostClass =
  (typeof GOVERNANCE_COST_CLASSES)[number]

export const GOVERNANCE_OPERATION_KINDS = [
  'query',
  'command',
  'preflight',
  'job',
] as const

export type GovernanceOperationKind =
  (typeof GOVERNANCE_OPERATION_KINDS)[number]

export interface GovernanceAdmissionScopeDecision {
  reasons: readonly GovernanceDecisionReason[]
  anomalies?: readonly Readonly<GovernanceAnomalyMeasurement>[]
  limits: Readonly<GovernanceLimits>
  usage: Readonly<GovernanceUsage>
  remaining: Readonly<{
    requests: number
    concurrency: number
    quotaUnits: number
    spendMinorUnits: number
  }>
}

export interface GovernanceAdmission {
  schemaVersion: GovernanceAdmissionSchemaVersion
  id: string
  workspaceId: string
  clientId: string
  capabilityId: string
  environment: 'sandbox' | 'production'
  operationKind: GovernanceOperationKind
  costClass: GovernanceCostClass
  allowed: boolean
  reasons: readonly GovernanceDecisionReason[]
  scopes: Readonly<{
    workspace: Readonly<GovernanceAdmissionScopeDecision>
    client: Readonly<GovernanceAdmissionScopeDecision>
  }>
  requested: Readonly<Required<GovernanceRequestedUsage>>
  anomalyPolicyHash?: string
  anomalyRecoveryBypassed?: boolean
  createdAt: string
  admissionHash: string
}

type GovernanceAdmissionContent = Omit<
  GovernanceAdmission,
  'schemaVersion' | 'admissionHash'
>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const CAPABILITY = /^apollo\.[a-z0-9_.-]{2,120}$/

function safeIntegerRecord(value: Record<string, number>): boolean {
  return Object.values(value).every((item) =>
    Number.isSafeInteger(item) && item >= 0 &&
      item <= MAX_GOVERNANCE_COUNTER)
}

function freezeScopeDecision(
  input: GovernanceAdmissionScopeDecision,
  schemaVersion: GovernanceAdmissionSchemaVersion,
): Readonly<GovernanceAdmissionScopeDecision> {
  const allowedReasons = schemaVersion === GOVERNANCE_ADMISSION_SCHEMA_VERSION
    ? GOVERNANCE_LIMIT_REASONS
    : [...GOVERNANCE_LIMIT_REASONS, ...GOVERNANCE_ANOMALY_REASONS]
  assertDomain(
    input.reasons.length === new Set(input.reasons).size &&
      input.reasons.every((reason) =>
        allowedReasons.includes(reason as never)),
    'INVALID_ARGUMENT',
    'governance scope decision reasons are invalid',
  )
  const limits = validateGovernanceLimits(input.limits)
  assertDomain(
    safeIntegerRecord(input.usage) && safeIntegerRecord(input.remaining),
    'INVALID_ARGUMENT',
    'governance scope decision counters are invalid',
  )
  const anomalies = Object.freeze((input.anomalies ?? []).map((item) => {
    assertDomain(
      GOVERNANCE_ANOMALY_REASONS.includes(item.reason) &&
        Number.isSafeInteger(item.observed) && item.observed >= 0 &&
        item.observed <= MAX_GOVERNANCE_COUNTER &&
        Number.isSafeInteger(item.threshold) && item.threshold >= 0 &&
        item.threshold <= MAX_GOVERNANCE_COUNTER &&
        (item.windowMs === 60_000 || item.windowMs === 300_000),
      'INVALID_ARGUMENT',
      'governance anomaly measurement is invalid',
    )
    return Object.freeze({ ...item })
  }))
  assertDomain(
    schemaVersion === GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2 ||
      anomalies.length === 0,
    'INVALID_ARGUMENT',
    'legacy governance admission cannot contain anomalies',
  )
  return Object.freeze({
    reasons: Object.freeze([...input.reasons]),
    limits,
    usage: Object.freeze({ ...input.usage }),
    remaining: Object.freeze({ ...input.remaining }),
    ...(schemaVersion === GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2
      ? { anomalies }
      : {}),
  })
}

export function createGovernanceAdmission(
  input: GovernanceAdmissionContent &
    Partial<Pick<GovernanceAdmission, 'schemaVersion' | 'admissionHash'>>,
): Readonly<GovernanceAdmission> {
  const schemaVersion = input.schemaVersion ??
    GOVERNANCE_ADMISSION_SCHEMA_VERSION
  assertDomain(
    schemaVersion === GOVERNANCE_ADMISSION_SCHEMA_VERSION ||
      schemaVersion === GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2,
    'INVALID_ARGUMENT',
    'governance admission schema version is invalid',
  )
  assertDomain(
    ID.test(input.id) && ID.test(input.workspaceId) && ID.test(input.clientId) &&
      CAPABILITY.test(input.capabilityId),
    'INVALID_ARGUMENT',
    'governance admission identity is invalid',
  )
  assertDomain(
    input.environment === 'sandbox' || input.environment === 'production',
    'INVALID_ARGUMENT',
    'governance admission environment is invalid',
  )
  assertDomain(
    GOVERNANCE_OPERATION_KINDS.includes(input.operationKind) &&
      GOVERNANCE_COST_CLASSES.includes(input.costClass),
    'INVALID_ARGUMENT',
    'governance admission classification is invalid',
  )
  const scopes = Object.freeze({
    workspace: freezeScopeDecision(input.scopes.workspace, schemaVersion),
    client: freezeScopeDecision(input.scopes.client, schemaVersion),
  })
  const reasonOrder: readonly GovernanceDecisionReason[] = schemaVersion ===
    GOVERNANCE_ADMISSION_SCHEMA_VERSION
    ? GOVERNANCE_LIMIT_REASONS
    : [...GOVERNANCE_LIMIT_REASONS, ...GOVERNANCE_ANOMALY_REASONS]
  const reasons = Object.freeze(reasonOrder.filter((reason) =>
    scopes.workspace.reasons.includes(reason) ||
      scopes.client.reasons.includes(reason)))
  assertDomain(
    input.reasons.length === reasons.length &&
      input.reasons.every((reason, index) => reason === reasons[index]) &&
      input.allowed === (reasons.length === 0),
    'INVALID_ARGUMENT',
    'governance admission decision is inconsistent',
  )
  const anomalyPolicyHash = input.anomalyPolicyHash
  const anomalyRecoveryBypassed = input.anomalyRecoveryBypassed ?? false
  const anomalies = [...(scopes.workspace.anomalies ?? []),
    ...(scopes.client.anomalies ?? [])]
  if (schemaVersion === GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2) {
    assertDomain(
      typeof anomalyPolicyHash === 'string' &&
        /^[a-f0-9]{64}$/.test(anomalyPolicyHash) &&
        typeof anomalyRecoveryBypassed === 'boolean' &&
        (!anomalyRecoveryBypassed || anomalies.length > 0) &&
        (!anomalyRecoveryBypassed ||
          !reasons.some((reason) => GOVERNANCE_ANOMALY_REASONS.includes(
            reason as GovernanceAnomalyReason,
          ))),
      'INVALID_ARGUMENT',
      'governance admission anomaly decision is invalid',
    )
  } else {
    assertDomain(
      anomalyPolicyHash === undefined && !anomalyRecoveryBypassed,
      'INVALID_ARGUMENT',
      'legacy governance admission cannot contain anomaly policy',
    )
  }
  assertDomain(
    safeIntegerRecord(input.requested),
    'INVALID_ARGUMENT',
    'governance admission requested counters are invalid',
  )
  const createdAt = Date.parse(input.createdAt)
  assertDomain(
    Number.isFinite(createdAt) &&
      new Date(createdAt).toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'governance admission timestamp is invalid',
  )
  const commonContent = {
    id: input.id,
    workspaceId: input.workspaceId,
    clientId: input.clientId,
    capabilityId: input.capabilityId,
    environment: input.environment,
    operationKind: input.operationKind,
    costClass: input.costClass,
    allowed: input.allowed,
    reasons,
    scopes,
    requested: Object.freeze({ ...input.requested }),
    createdAt: input.createdAt,
  }
  const content = schemaVersion === GOVERNANCE_ADMISSION_SCHEMA_VERSION_V2
    ? {
        ...commonContent,
        anomalyPolicyHash: anomalyPolicyHash!,
        anomalyRecoveryBypassed,
      }
    : commonContent
  const admissionHash = calculateCanonicalHash({
    schemaVersion,
    ...content,
  })
  assertDomain(
    input.admissionHash === undefined || input.admissionHash === admissionHash,
    'PERSISTENCE_CONFLICT',
    'governance admission hash is invalid',
  )
  return Object.freeze({
    schemaVersion,
    ...content,
    admissionHash,
  })
}
