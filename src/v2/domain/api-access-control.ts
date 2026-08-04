import { API_ENVIRONMENTS, type ApiEnvironment } from './api-client.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { WORKSPACE_MEMBER_ROLES, type WorkspaceMemberRole } from './workspace-member.ts'

export const API_ACCESS_STATUSES = ['active', 'suspended', 'revoked'] as const
export const API_ACCESS_ACTIONS = [
  'activate',
  'suspend',
  'revoke',
  'engage-kill-switch',
  'release-kill-switch',
] as const
export const API_ACCESS_TARGET_TYPES = ['client', 'workspace'] as const

export type ApiAccessStatus = (typeof API_ACCESS_STATUSES)[number]
export type ApiAccessAction = (typeof API_ACCESS_ACTIONS)[number]
export type ApiAccessTargetType = (typeof API_ACCESS_TARGET_TYPES)[number]
export type ApiAccessAuthenticationKind = 'bearer' | 'ui-session'

export interface ApiAccessAuditContext {
  readonly clientId: string
  readonly credentialId: string
  readonly workspaceId: string
  readonly environment: ApiEnvironment
  readonly authenticationKind: ApiAccessAuthenticationKind
  readonly delegatedUserId?: string
  readonly delegatedIdentityId?: string
  readonly workspaceRole?: WorkspaceMemberRole
  readonly contextHash: string
}

export interface ApiAccessControl {
  readonly schemaVersion: 1
  readonly workspaceId: string
  readonly targetType: ApiAccessTargetType
  readonly targetId: string
  readonly status: ApiAccessStatus
  readonly killSwitchEngaged: boolean
  readonly revision: string
}

export interface ApiAccessCommand {
  readonly schemaVersion: 1
  readonly id: string
  readonly workspaceId: string
  readonly targetType: ApiAccessTargetType
  readonly targetId: string
  readonly action: ApiAccessAction
  readonly baseRevision: string
  readonly resultRevision: string
  readonly previousStatus: ApiAccessStatus
  readonly resultStatus: ApiAccessStatus
  readonly previousKillSwitchEngaged: boolean
  readonly resultKillSwitchEngaged: boolean
  readonly reason: string
  readonly actorClientId: string
  readonly delegatedUserId?: string
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  readonly changedAt: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

export function createApiAccessAuditContext(input: Omit<ApiAccessAuditContext, 'contextHash'>): Readonly<ApiAccessAuditContext> {
  assertDomain(
    ID_PATTERN.test(input.clientId) && ID_PATTERN.test(input.credentialId) &&
      ID_PATTERN.test(input.workspaceId),
    'AUTH_INVALID',
    'API access audit identity is invalid',
  )
  assertDomain(
    API_ENVIRONMENTS.includes(input.environment) &&
      (input.authenticationKind === 'bearer' || input.authenticationKind === 'ui-session'),
    'AUTH_INVALID',
    'API access audit authentication is invalid',
  )
  const delegation = [input.delegatedUserId, input.delegatedIdentityId, input.workspaceRole]
  const hasCompleteDelegation = delegation.every(Boolean)
  assertDomain(
    input.authenticationKind === 'ui-session'
      ? hasCompleteDelegation
      : delegation.every((value) => value === undefined),
    'AUTH_INVALID',
    'API access audit delegation does not match its authentication kind',
  )
  if (hasCompleteDelegation) {
    assertDomain(
      ID_PATTERN.test(input.delegatedUserId as string) &&
        ID_PATTERN.test(input.delegatedIdentityId as string) &&
        WORKSPACE_MEMBER_ROLES.includes(input.workspaceRole as WorkspaceMemberRole),
      'AUTH_INVALID',
      'API access audit delegation is invalid',
    )
  }
  const canonical = {
    clientId: input.clientId,
    credentialId: input.credentialId,
    workspaceId: input.workspaceId,
    environment: input.environment,
    authenticationKind: input.authenticationKind,
    delegatedUserId: input.delegatedUserId ?? null,
    delegatedIdentityId: input.delegatedIdentityId ?? null,
    workspaceRole: input.workspaceRole ?? null,
  }
  return Object.freeze({ ...input, contextHash: calculateCanonicalHash(canonical) })
}

export function assertApiAccessAuditBinding(
  command: Pick<ApiAccessCommand, 'workspaceId' | 'actorClientId' | 'delegatedUserId'>,
  audit: ApiAccessAuditContext,
): void {
  const canonical = createApiAccessAuditContext({
    clientId: audit.clientId,
    credentialId: audit.credentialId,
    workspaceId: audit.workspaceId,
    environment: audit.environment,
    authenticationKind: audit.authenticationKind,
    ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}),
    ...(audit.delegatedIdentityId ? { delegatedIdentityId: audit.delegatedIdentityId } : {}),
    ...(audit.workspaceRole ? { workspaceRole: audit.workspaceRole } : {}),
  })
  assertDomain(
    canonical.contextHash === audit.contextHash &&
      audit.clientId === command.actorClientId &&
      audit.workspaceId === command.workspaceId &&
      audit.delegatedUserId === command.delegatedUserId,
    'AUTH_INVALID',
    'API access command audit context does not match its actor',
  )
}

export function createApiAccessControl(
  input: Omit<ApiAccessControl, 'schemaVersion'>,
): Readonly<ApiAccessControl> {
  assertDomain(
    ID_PATTERN.test(input.workspaceId) && ID_PATTERN.test(input.targetId),
    'INVALID_ARGUMENT',
    'API access target identity is invalid',
  )
  assertDomain(
    API_ACCESS_TARGET_TYPES.includes(input.targetType) &&
      API_ACCESS_STATUSES.includes(input.status) &&
      HASH_PATTERN.test(input.revision),
    'INVALID_ARGUMENT',
    'API access state is invalid',
  )
  assertDomain(
    input.targetType !== 'workspace' || input.targetId === input.workspaceId,
    'INVALID_ARGUMENT',
    'Workspace access target must match its workspace',
  )
  return Object.freeze({ ...input, schemaVersion: 1 as const })
}

function transitionStatus(status: ApiAccessStatus, action: ApiAccessAction): ApiAccessStatus {
  if (status === 'revoked') {
    assertDomain(action === 'revoke', 'INVALID_ARGUMENT', 'Revoked API access is terminal')
    return 'revoked'
  }
  if (action === 'activate') {
    assertDomain(status === 'suspended', 'INVALID_ARGUMENT', 'Only suspended API access can be activated')
    return 'active'
  }
  if (action === 'suspend') {
    assertDomain(status === 'active', 'INVALID_ARGUMENT', 'Only active API access can be suspended')
    return 'suspended'
  }
  if (action === 'revoke') return 'revoked'
  return status
}

function transitionKillSwitch(engaged: boolean, action: ApiAccessAction): boolean {
  if (action === 'engage-kill-switch') {
    assertDomain(!engaged, 'INVALID_ARGUMENT', 'API kill switch is already engaged')
    return true
  }
  if (action === 'release-kill-switch') {
    assertDomain(engaged, 'INVALID_ARGUMENT', 'API kill switch is not engaged')
    return false
  }
  return engaged
}

export function transitionApiAccessControl(
  current: ApiAccessControl,
  action: ApiAccessAction,
): Readonly<Pick<ApiAccessCommand,
  'previousStatus' | 'resultStatus' |
  'previousKillSwitchEngaged' | 'resultKillSwitchEngaged'>> {
  assertDomain(API_ACCESS_ACTIONS.includes(action), 'INVALID_ARGUMENT', 'API access action is invalid')
  return Object.freeze({
    previousStatus: current.status,
    resultStatus: transitionStatus(current.status, action),
    previousKillSwitchEngaged: current.killSwitchEngaged,
    resultKillSwitchEngaged: transitionKillSwitch(current.killSwitchEngaged, action),
  })
}
