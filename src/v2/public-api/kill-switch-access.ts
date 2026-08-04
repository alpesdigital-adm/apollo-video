import type { AuthenticatedExternalActor } from '../application/authenticate-api-client.ts'
import { DomainError } from '../domain/errors.ts'

const KILL_SWITCH_RECOVERY_CAPABILITIES = new Set([
  'apollo.api-access.clients.read',
  'apollo.api-access.clients.change',
  'apollo.api-access.workspace.read',
  'apollo.api-access.workspace.change',
])

export function assertKillSwitchRecoveryAccess(
  actor: AuthenticatedExternalActor,
  capabilityId: string,
): void {
  if (
    actor.clientAccessStatus === 'active' && actor.workspaceAccessStatus === 'active' &&
    !actor.clientKillSwitchEngaged && !actor.workspaceKillSwitchEngaged
  ) return
  if (
    actor.authenticationKind === 'ui-session' &&
    actor.delegatedUserId &&
    actor.workspaceRole === 'administrator' &&
    KILL_SWITCH_RECOVERY_CAPABILITIES.has(capabilityId)
  ) return
  throw new DomainError('OPERATIONAL_KILL_SWITCH_ACTIVE', 'API access kill switch is active')
}
