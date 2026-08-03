import type { ApiEnvironment } from '../domain/api-client.ts'
import { isApiCredentialUsable } from '../domain/api-credential.ts'
import { DomainError } from '../domain/errors.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { ApiCredentialCrypto } from './ports/api-credential-crypto.ts'

export interface AuthenticatedExternalActor {
  clientId: string
  credentialId: string
  workspaceId: string
  environment: ApiEnvironment
  scopes: ReadonlySet<string>
  delegatedUserId?: string
  delegatedIdentityId?: string
  workspaceRole?: string
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

    return Object.freeze({
      clientId: stored.client.id,
      credentialId: stored.credential.id,
      workspaceId: stored.client.workspaceId,
      environment: dependencies.environment,
      scopes: new Set(stored.client.scopeGrants),
    }) as AuthenticatedExternalActor
  }
}

export function requireScope(actor: AuthenticatedExternalActor, scope: string): void {
  if (!actor.scopes.has(scope)) {
    throw new DomainError('AUTH_SCOPE_REQUIRED', 'API client lacks the required scope', {
      requiredScope: scope,
    })
  }
}
