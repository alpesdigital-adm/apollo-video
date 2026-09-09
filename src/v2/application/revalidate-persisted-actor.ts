import { createExternalAuditContext, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { createApiScopeSet } from '../domain/api-client.ts'
import { isApiCredentialUsable } from '../domain/api-credential.ts'
import { DomainError } from '../domain/errors.ts'

export async function revalidatePersistedActor(input: {
  audit: Readonly<ApiAccessAuditContext>
  clients: ApiClientRepository
  clock: () => Date
  validateDelegation: (audit: Readonly<ApiAccessAuditContext>) => Promise<boolean>
}): Promise<Readonly<AuthenticatedExternalActor>> {
  const access = await input.clients.findActiveClientAccessById(input.audit.clientId)
  if (!access || access.client.workspaceId !== input.audit.workspaceId ||
    !access.client.allowedEnvironments.includes(input.audit.environment) ||
    access.clientKillSwitchEngaged || access.workspaceKillSwitchEngaged || access.workspaceAccessStatus !== 'active') {
    throw new DomainError('AUTH_INVALID', 'Persisted actor no longer has active workspace access')
  }
  if (input.audit.authenticationKind === 'bearer') {
    const credential = await input.clients.findCredentialById(input.audit.clientId, input.audit.credentialId)
    if (!credential || !isApiCredentialUsable(credential.credential, input.clock())) {
      throw new DomainError('AUTH_INVALID', 'Persisted actor credential is no longer usable')
    }
  }
  if ((input.audit.delegatedUserId || input.audit.delegatedIdentityId || input.audit.workspaceRole) &&
    !(await input.validateDelegation(input.audit))) {
    throw new DomainError('AUTH_INVALID', 'Persisted delegated actor is no longer active')
  }
  const scopes = createApiScopeSet(access.client.scopeGrants)
  const auditContext = createExternalAuditContext({
    clientId: input.audit.clientId, credentialId: input.audit.credentialId,
    workspaceId: input.audit.workspaceId, environment: input.audit.environment,
    ...(input.audit.delegatedUserId ? { delegatedUserId: input.audit.delegatedUserId } : {}),
    ...(input.audit.delegatedIdentityId ? { delegatedIdentityId: input.audit.delegatedIdentityId } : {}),
    ...(input.audit.workspaceRole ? { workspaceRole: input.audit.workspaceRole } : {}),
  })
  return Object.freeze({
    ...auditContext, scopes, authenticationKind: input.audit.authenticationKind,
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}
