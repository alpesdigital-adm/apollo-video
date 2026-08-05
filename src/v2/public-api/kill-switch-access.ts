import type { AuthenticatedExternalActor } from '../application/authenticate-api-client.ts'
import { DomainError } from '../domain/errors.ts'

const KILL_SWITCH_RECOVERY_CAPABILITIES = new Set([
  'apollo.api-access.clients.read',
  'apollo.api-access.clients.change',
  'apollo.api-access.workspace.read',
  'apollo.api-access.workspace.change',
  'apollo.governance.policies.list',
  'apollo.governance.policies.set',
  'apollo.governance.policies.delete',
])

export function assertKillSwitchRecoveryAccess(
  actor: AuthenticatedExternalActor,
  capabilityId: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const environmentKillSwitchEngaged =
    environment.APOLLO_OPERATIONAL_KILL_SWITCH?.trim().toLowerCase() === 'true'
  if (
    !environmentKillSwitchEngaged &&
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
