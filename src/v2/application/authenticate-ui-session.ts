import type { ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import type { ApolloUiSession } from '../domain/ui-session.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { UiSessionSecurityRepository } from './ports/ui-session-security-repository.ts'

export const UI_SESSION_IDLE_TTL_SECONDS = 30 * 60

export function authenticateUiSessionService(dependencies: {
  repository: ApiClientRepository
  sessions: UiSessionSecurityRepository
  environment: ApiEnvironment
  now?: () => Date
}) {
  return async function authenticate(session: Readonly<ApolloUiSession> | null, nonceHash?: string, subjectHash?: string) {
    if (!session) throw new DomainError('AUTH_INVALID', 'Apollo session is required')
    if (!nonceHash) throw new DomainError('AUTH_INVALID', 'Apollo session is required')
    const now = dependencies.now?.() ?? new Date()
    const durable = await dependencies.sessions.readActiveAndTouch({
      nonceHash, now: now.toISOString(), idleTtlSeconds: UI_SESSION_IDLE_TTL_SECONDS,
    })
    if (
      !durable || durable.clientId !== session.clientId || durable.subjectHash !== subjectHash ||
      durable.issuedAt !== new Date(session.issuedAt * 1000).toISOString() ||
      durable.expiresAt !== new Date(session.expiresAt * 1000).toISOString()
    ) {
      throw new DomainError('AUTH_INVALID', 'Apollo session is no longer authorized')
    }
    const client = await dependencies.repository.findActiveClientById(session.clientId)
    if (!client || client.environment !== dependencies.environment || client.workspaceId !== durable.workspaceId) {
      throw new DomainError('AUTH_INVALID', 'Apollo session is no longer authorized')
    }
    return Object.freeze({
      clientId: client.id,
      credentialId: `ui-session:${session.nonce}`,
      workspaceId: client.workspaceId,
      environment: client.environment,
      scopes: new Set(client.scopes),
      sessionExpiresAt: durable.expiresAt,
    })
  }
}
