import { createApiScopeSet, type ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { UiSessionSecurityRepository } from './ports/ui-session-security-repository.ts'
import { createExternalAuditContext } from './authenticate-api-client.ts'

export const UI_SESSION_IDLE_TTL_SECONDS = 30 * 60
export const UI_SESSION_ROTATE_AFTER_SECONDS = 10 * 60
export const UI_SESSION_IDENTIFIER_MAX_AGE_SECONDS = 15 * 60
export const UI_SESSION_ROTATION_RECOVERY_SECONDS = 60
const SESSION_HASH = /^[a-f0-9]{64}$/

export function authenticateUiSessionService(dependencies: {
  repository: ApiClientRepository
  sessions: UiSessionSecurityRepository
  environment: ApiEnvironment
  now?: () => Date
}) {
  return async function authenticate(
    sessionToken: string | null,
    nonceHash?: string,
    rotation?: Readonly<{ successorNonceHash: string }>,
  ) {
    if (!sessionToken) throw new DomainError('AUTH_INVALID', 'Apollo session is required')
    if (!nonceHash || !SESSION_HASH.test(nonceHash)) throw new DomainError('AUTH_INVALID', 'Apollo session is required')
    if (rotation && (!SESSION_HASH.test(rotation.successorNonceHash) || rotation.successorNonceHash === nonceHash)) {
      throw new DomainError('AUTH_INVALID', 'Apollo session rotation is invalid')
    }
    const now = dependencies.now?.() ?? new Date()
    const refreshed = rotation
      ? await dependencies.sessions.refreshActiveSession({
        currentNonceHash: nonceHash,
        successorNonceHash: rotation.successorNonceHash,
        now: now.toISOString(),
        idleTtlSeconds: UI_SESSION_IDLE_TTL_SECONDS,
        rotateAfterSeconds: UI_SESSION_ROTATE_AFTER_SECONDS,
        identifierMaxAgeSeconds: UI_SESSION_IDENTIFIER_MAX_AGE_SECONDS,
        recoverySeconds: UI_SESSION_ROTATION_RECOVERY_SECONDS,
      })
      : null
    const durable = refreshed?.session ?? (!rotation
      ? await dependencies.sessions.readActiveAndTouch({
        nonceHash,
        now: now.toISOString(),
        idleTtlSeconds: UI_SESSION_IDLE_TTL_SECONDS,
        identifierMaxAgeSeconds: UI_SESSION_IDENTIFIER_MAX_AGE_SECONDS,
      })
      : null)
    if (
      !durable
    ) {
      throw new DomainError('AUTH_INVALID', 'Apollo session is no longer authorized')
    }
    const access = await dependencies.repository.findActiveClientAccessById(durable.clientId)
    const client = access?.client
    if (!access || !client || !client.allowedEnvironments.includes(dependencies.environment) || client.workspaceId !== durable.workspaceId) {
      throw new DomainError('AUTH_INVALID', 'Apollo session is no longer authorized')
    }
    const auditContext = createExternalAuditContext({
      clientId: client.id,
      credentialId: `ui-session:${nonceHash}`,
      workspaceId: client.workspaceId,
      delegatedUserId: durable.memberId,
      delegatedIdentityId: durable.identityId,
      workspaceRole: durable.memberRole,
      environment: dependencies.environment,
    })
    return Object.freeze({
      ...auditContext,
      scopes: createApiScopeSet(client.scopeGrants),
      authenticationKind: 'ui-session' as const,
      clientKillSwitchEngaged: access.clientKillSwitchEngaged,
      workspaceKillSwitchEngaged: access.workspaceKillSwitchEngaged,
      clientAccessStatus: client.status,
      workspaceAccessStatus: access.workspaceAccessStatus,
      auditContext,
      sessionExpiresAt: durable.expiresAt,
      sessionTokenRotated: refreshed?.rotated ?? false,
    })
  }
}
