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

export const GOVERNANCE_ADMISSION_SCHEMA_VERSION =
  'governance-admission/v1' as const

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
  reasons: readonly GovernanceLimitReason[]
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
  schemaVersion: typeof GOVERNANCE_ADMISSION_SCHEMA_VERSION
  id: string
  workspaceId: string
  clientId: string
  capabilityId: string
  environment: 'sandbox' | 'production'
  operationKind: GovernanceOperationKind
  costClass: GovernanceCostClass
  allowed: boolean
  reasons: readonly GovernanceLimitReason[]
  scopes: Readonly<{
    workspace: Readonly<GovernanceAdmissionScopeDecision>
    client: Readonly<GovernanceAdmissionScopeDecision>
  }>
  requested: Readonly<Required<GovernanceRequestedUsage>>
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
): Readonly<GovernanceAdmissionScopeDecision> {
  assertDomain(
    input.reasons.length === new Set(input.reasons).size &&
      input.reasons.every((reason) =>
        GOVERNANCE_LIMIT_REASONS.includes(reason)),
    'INVALID_ARGUMENT',
    'governance scope decision reasons are invalid',
  )
  const limits = validateGovernanceLimits(input.limits)
  assertDomain(
    safeIntegerRecord(input.usage) && safeIntegerRecord(input.remaining),
    'INVALID_ARGUMENT',
    'governance scope decision counters are invalid',
  )
  return Object.freeze({
    reasons: Object.freeze([...input.reasons]),
    limits,
    usage: Object.freeze({ ...input.usage }),
    remaining: Object.freeze({ ...input.remaining }),
  })
}

export function createGovernanceAdmission(
  input: GovernanceAdmissionContent &
    Partial<Pick<GovernanceAdmission, 'schemaVersion' | 'admissionHash'>>,
): Readonly<GovernanceAdmission> {
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
    workspace: freezeScopeDecision(input.scopes.workspace),
    client: freezeScopeDecision(input.scopes.client),
  })
  const reasons = Object.freeze(GOVERNANCE_LIMIT_REASONS.filter((reason) =>
    scopes.workspace.reasons.includes(reason) ||
      scopes.client.reasons.includes(reason)))
  assertDomain(
    input.reasons.length === reasons.length &&
      input.reasons.every((reason, index) => reason === reasons[index]) &&
      input.allowed === (reasons.length === 0),
    'INVALID_ARGUMENT',
    'governance admission decision is inconsistent',
  )
  assertDomain(
    safeIntegerRecord(input.requested),
    'INVALID_ARGUMENT',
    'governance admission requested counters are invalid',
  )
  assertDomain(
    new Date(input.createdAt).toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'governance admission timestamp is invalid',
  )
  const content = {
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
  const admissionHash = calculateCanonicalHash({
    schemaVersion: GOVERNANCE_ADMISSION_SCHEMA_VERSION,
    ...content,
  })
  assertDomain(
    input.admissionHash === undefined || input.admissionHash === admissionHash,
    'PERSISTENCE_CONFLICT',
    'governance admission hash is invalid',
  )
  return Object.freeze({
    schemaVersion: GOVERNANCE_ADMISSION_SCHEMA_VERSION,
    ...content,
    admissionHash,
  })
}
