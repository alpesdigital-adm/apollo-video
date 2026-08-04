import {
  API_ENVIRONMENTS,
  createApiScopeSet,
  isApiScope,
  type ApiEnvironment,
  type ApiScope,
} from '../domain/api-client.ts'
import type { ApiAccessStatus } from '../domain/api-access-control.ts'
import { isApiCredentialUsable } from '../domain/api-credential.ts'
import { DomainError } from '../domain/errors.ts'
import { WORKSPACE_MEMBER_ROLES } from '../domain/workspace-member.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { ApiCredentialCrypto } from './ports/api-credential-crypto.ts'

export interface AuthenticatedExternalActor {
  clientId: string
  credentialId: string
  workspaceId: string
  environment: ApiEnvironment
  scopes: ReadonlySet<ApiScope>
  delegatedUserId?: string
  delegatedIdentityId?: string
  workspaceRole?: string
  authenticationKind: 'bearer' | 'ui-session'
  clientKillSwitchEngaged: boolean
  workspaceKillSwitchEngaged: boolean
  clientAccessStatus: ApiAccessStatus
  workspaceAccessStatus: ApiAccessStatus
  auditContext: ExternalAuditContext
}

export interface ExternalAuditContext {
  clientId: string
  credentialId: string
  workspaceId: string
  environment: ApiEnvironment
  delegatedUserId?: string
  delegatedIdentityId?: string
  workspaceRole?: string
  actor: Readonly<{
    type: 'api-client'
    id: string
    delegatedUserId?: string
  }>
}

function assertAuditIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new DomainError('AUTH_INVALID', `Authenticated ${field} is invalid`)
  }
}

export function createExternalAuditContext(input: {
  clientId: string
  credentialId: string
  workspaceId: string
  environment: ApiEnvironment
  delegatedUserId?: string
  delegatedIdentityId?: string
  workspaceRole?: string
}): Readonly<ExternalAuditContext> {
  if (!API_ENVIRONMENTS.includes(input.environment)) {
    throw new DomainError('AUTH_INVALID', 'Authenticated environment is invalid')
  }
  assertAuditIdentifier(input.clientId, 'client identity')
  assertAuditIdentifier(input.credentialId, 'credential identity')
  assertAuditIdentifier(input.workspaceId, 'workspace identity')
  const delegation = [input.delegatedUserId, input.delegatedIdentityId, input.workspaceRole]
  if (delegation.some(Boolean) && !delegation.every(Boolean)) {
    throw new DomainError('AUTH_INVALID', 'Authenticated delegation context is incomplete')
  }
  if (input.workspaceRole && !WORKSPACE_MEMBER_ROLES.includes(input.workspaceRole as typeof WORKSPACE_MEMBER_ROLES[number])) {
    throw new DomainError('AUTH_INVALID', 'Authenticated workspace role is invalid')
  }
  for (const [field, value] of [
    ['delegated user identity', input.delegatedUserId],
    ['delegated login identity', input.delegatedIdentityId],
    ['workspace role', input.workspaceRole],
  ] as const) {
    if (value) assertAuditIdentifier(value, field)
  }
  const actor = Object.freeze({
    type: 'api-client' as const,
    id: input.clientId,
    ...(input.delegatedUserId ? { delegatedUserId: input.delegatedUserId } : {}),
  })
  return Object.freeze({ ...input, actor })
}

export function assertExternalAuditContextBinding(actor: AuthenticatedExternalActor): void {
  const audit = actor.auditContext
  if (
    !audit || audit.clientId !== actor.clientId || audit.credentialId !== actor.credentialId ||
    audit.workspaceId !== actor.workspaceId || audit.environment !== actor.environment ||
    audit.delegatedUserId !== actor.delegatedUserId ||
    audit.delegatedIdentityId !== actor.delegatedIdentityId ||
    audit.workspaceRole !== actor.workspaceRole || audit.actor.type !== 'api-client' ||
    audit.actor.id !== actor.clientId || audit.actor.delegatedUserId !== actor.delegatedUserId
  ) {
    throw new DomainError('AUTH_INVALID', 'Authenticated audit context does not match the request actor')
  }
}

export interface AuthenticateApiClientDependencies {
  repository: ApiClientRepository
  clock: () => Date
  environment: ApiEnvironment
  credentialCrypto: ApiCredentialCrypto
}

export function authenticateApiClientService(
  dependencies: AuthenticateApiClientDependencies,
) {
  return async function authenticate(authorizationHeader: string | null) {
    const authorization = authorizationHeader && authorizationHeader.length <= 256
      ? /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorizationHeader)
      : null
    if (!authorization) {
      throw new DomainError('AUTH_INVALID', 'Bearer API credential is required')
    }

    const parsed = dependencies.credentialCrypto.parse(authorization[1])
    const stored = await dependencies.repository.findCredentialById(
      parsed.clientId,
      parsed.credentialId,
    )

    const authenticatedAt = dependencies.clock()
    if (
      !stored ||
      stored.client.status !== 'active' ||
      !isApiCredentialUsable(stored.credential, authenticatedAt) ||
      !stored.client.allowedEnvironments.includes(dependencies.environment) ||
      !(await dependencies.credentialCrypto.verify(
        parsed.secret,
        stored.secretSalt,
        stored.secretHash,
      ))
    ) {
      throw new DomainError('AUTH_INVALID', 'Invalid API credential')
    }

    await dependencies.repository.touchLastUsed(
      stored.client.id,
      stored.credential.id,
      authenticatedAt.toISOString(),
    )

    const auditContext = createExternalAuditContext({
      clientId: stored.client.id,
      credentialId: stored.credential.id,
      workspaceId: stored.client.workspaceId,
      environment: dependencies.environment,
    })
    return Object.freeze({
      ...auditContext,
      scopes: createApiScopeSet(stored.client.scopeGrants),
      authenticationKind: 'bearer' as const,
      clientKillSwitchEngaged: stored.clientKillSwitchEngaged,
      workspaceKillSwitchEngaged: stored.workspaceKillSwitchEngaged,
      clientAccessStatus: 'active' as const,
      workspaceAccessStatus: stored.workspaceAccessStatus,
      auditContext,
    }) as AuthenticatedExternalActor
  }
}

export function requireScope(actor: AuthenticatedExternalActor, scope: ApiScope): void {
  assertExternalAuditContextBinding(actor)
  const requiresHumanAdministrator = scope === 'clients:admin' || scope === 'webhooks:admin'
  if (
    !isApiScope(scope) || !actor.scopes.has(scope) ||
    (actor.authenticationKind === 'ui-session' && requiresHumanAdministrator && actor.workspaceRole !== 'administrator')
  ) {
    throw new DomainError('AUTH_SCOPE_REQUIRED', 'API client lacks the required scope', {
      requiredScope: scope,
    })
  }
}
