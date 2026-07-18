import type { ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import type { ApolloUiSession } from '../domain/ui-session.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'

export function authenticateUiSessionService(dependencies: {
  repository: ApiClientRepository
  environment: ApiEnvironment
}) {
  return async function authenticate(session: Readonly<ApolloUiSession> | null) {
    if (!session) throw new DomainError('AUTH_INVALID', 'Apollo session is required')
    const client = await dependencies.repository.findActiveClientById(session.clientId)
    if (!client || client.environment !== dependencies.environment) {
      throw new DomainError('AUTH_INVALID', 'Apollo session is no longer authorized')
    }
    return Object.freeze({
      clientId: client.id,
      credentialId: `ui-session:${session.nonce}`,
      workspaceId: client.workspaceId,
      environment: client.environment,
      scopes: new Set(client.scopes),
    }) as AuthenticatedExternalActor
  }
}
