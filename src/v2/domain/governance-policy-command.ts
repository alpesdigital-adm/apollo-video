import type { ApiAccessAuditContext } from './api-access-control.ts'
import { createApiAccessAuditContext } from './api-access-control.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { GovernanceLimits, GovernancePolicy } from './governance-limits.ts'
import { validateGovernanceLimits } from './governance-limits.ts'

export const GOVERNANCE_POLICY_COMMAND_SCHEMA_VERSION =
  'governance-policy-command/v1' as const

export type GovernancePolicyCommandAction = 'set' | 'delete'

export interface GovernancePolicyCommand {
  schemaVersion: typeof GOVERNANCE_POLICY_COMMAND_SCHEMA_VERSION
  id: string
  workspaceId: string
  action: GovernancePolicyCommandAction
  policyId: string
  scopeType: GovernancePolicy['scopeType']
  scopeId: string
  environment: GovernancePolicy['environment']
  limits?: Readonly<GovernanceLimits>
  baseRevision?: string
  resultRevision?: string
  reason: string
  audit: Readonly<ApiAccessAuditContext>
  idempotencyKey: string
  requestFingerprint: string
  resultHash: string
  occurredAt: string
  commandHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const VISIBLE_ASCII = /^[\x21-\x7E]{8,128}$/

function canonicalTimestamp(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

export function calculateGovernancePolicyCommandResultHash(
  result: Readonly<{
    action: GovernancePolicyCommandAction
    policy?: Readonly<GovernancePolicy>
    deletedPolicyId?: string
  }>,
): string {
  return calculateCanonicalHash({
    schemaVersion: 'governance-policy-command-result/v1',
    ...result,
  })
}

export function createGovernancePolicyCommand(
  input: Omit<GovernancePolicyCommand, 'schemaVersion' | 'commandHash'> & {
    commandHash?: string
  },
): Readonly<GovernancePolicyCommand> {
  assertDomain(
    ID.test(input.id) && ID.test(input.workspaceId) && ID.test(input.policyId) &&
      ID.test(input.scopeId),
    'INVALID_ARGUMENT',
    'governance policy command identity is invalid',
  )
  assertDomain(
    (input.scopeType === 'workspace' && input.scopeId === input.workspaceId) ||
      input.scopeType === 'client',
    'INVALID_ARGUMENT',
    'governance policy command scope is invalid',
  )
  assertDomain(
    input.environment === 'sandbox' || input.environment === 'production',
    'INVALID_ARGUMENT',
    'governance policy command environment is invalid',
  )
  assertDomain(
    input.action === 'set' || input.action === 'delete',
    'INVALID_ARGUMENT',
    'governance policy command action is invalid',
  )
  const limits = input.limits
    ? validateGovernanceLimits(input.limits)
    : undefined
  assertDomain(
    input.action === 'set'
      ? limits !== undefined && HASH.test(input.resultRevision ?? '')
      : limits === undefined && input.resultRevision === undefined &&
        HASH.test(input.baseRevision ?? ''),
    'INVALID_ARGUMENT',
    'governance policy command transition is invalid',
  )
  assertDomain(
    input.baseRevision === undefined || HASH.test(input.baseRevision),
    'INVALID_ARGUMENT',
    'governance policy command base revision is invalid',
  )
  const reason = input.reason.trim().replace(/\s+/g, ' ')
  assertDomain(
    reason.length >= 3 && reason.length <= 500 &&
      VISIBLE_ASCII.test(input.idempotencyKey) &&
      HASH.test(input.requestFingerprint) && HASH.test(input.resultHash) &&
      canonicalTimestamp(input.occurredAt),
    'INVALID_ARGUMENT',
    'governance policy command evidence is invalid',
  )
  const audit = createApiAccessAuditContext({
    clientId: input.audit.clientId,
    credentialId: input.audit.credentialId,
    workspaceId: input.audit.workspaceId,
    environment: input.audit.environment,
    authenticationKind: input.audit.authenticationKind,
    ...(input.audit.delegatedUserId
      ? { delegatedUserId: input.audit.delegatedUserId }
      : {}),
    ...(input.audit.delegatedIdentityId
      ? { delegatedIdentityId: input.audit.delegatedIdentityId }
      : {}),
    ...(input.audit.workspaceRole
      ? { workspaceRole: input.audit.workspaceRole }
      : {}),
  })
  assertDomain(
    audit.contextHash === input.audit.contextHash &&
      audit.workspaceId === input.workspaceId,
    'AUTH_INVALID',
    'governance policy command audit is invalid',
  )
  const content = {
    id: input.id,
    workspaceId: input.workspaceId,
    action: input.action,
    policyId: input.policyId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    environment: input.environment,
    ...(limits ? { limits } : {}),
    ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
    ...(input.resultRevision
      ? { resultRevision: input.resultRevision }
      : {}),
    reason,
    audit,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    resultHash: input.resultHash,
    occurredAt: input.occurredAt,
  }
  const commandHash = calculateCanonicalHash({
    schemaVersion: GOVERNANCE_POLICY_COMMAND_SCHEMA_VERSION,
    ...content,
  })
  assertDomain(
    input.commandHash === undefined || input.commandHash === commandHash,
    'PERSISTENCE_CONFLICT',
    'governance policy command hash is invalid',
  )
  return Object.freeze({
    schemaVersion: GOVERNANCE_POLICY_COMMAND_SCHEMA_VERSION,
    ...content,
    commandHash,
  })
}
