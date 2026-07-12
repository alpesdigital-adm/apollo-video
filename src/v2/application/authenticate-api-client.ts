import type { ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { ApiCredentialCrypto } from './ports/api-credential-crypto.ts'

export interface AuthenticatedExternalActor {
  clientId: string
  workspaceId: string
  environment: ApiEnvironment
  scopes: ReadonlySet<string>
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
    if (!authorizationHeader?.startsWith('Bearer ')) {
      throw new DomainError('AUTH_INVALID', 'Bearer API credential is required')
    }

    const parsed = dependencies.credentialCrypto.parse(
      authorizationHeader.slice('Bearer '.length).trim(),
    )
    const stored = await dependencies.repository.findCredentialById(parsed.clientId)

    if (
      !stored ||
      stored.client.status !== 'active' ||
      stored.client.environment !== dependencies.environment ||
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
      dependencies.clock().toISOString(),
    )

    return Object.freeze({
      clientId: stored.client.id,
      workspaceId: stored.client.workspaceId,
      environment: stored.client.environment,
      scopes: new Set(stored.client.scopes),
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
