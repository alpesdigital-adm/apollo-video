import { assertDomain } from './errors.ts'

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
