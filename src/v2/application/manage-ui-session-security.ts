import { assertDomain } from '../domain/errors.ts'
import type { ApolloUiSession } from '../domain/ui-session.ts'
import type { UiLoginAttemptOutcome, UiSessionSecurityRepository } from './ports/ui-session-security-repository.ts'
import { UI_SESSION_IDLE_TTL_SECONDS } from './authenticate-ui-session.ts'

export const UI_LOGIN_MAX_ATTEMPTS = 6
export const UI_LOGIN_WINDOW_MS = 15 * 60 * 1000

const HASH = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/

export function createDurableUiSessionService(dependencies: { sessions: UiSessionSecurityRepository }) {
  return async function create(input: {
    session: ApolloUiSession; nonceHash: string; subjectHash: string; workspaceId: string; memberId: string
  }) {
    assertDomain(HASH.test(input.nonceHash) && HASH.test(input.subjectHash), 'INVALID_ARGUMENT', 'Session hashes are invalid')
    return dependencies.sessions.createSession({ ...input, idleTtlSeconds: UI_SESSION_IDLE_TTL_SECONDS })
  }
}

export function revokeDurableUiSessionService(dependencies: { sessions: UiSessionSecurityRepository; now?: () => Date }) {
  return async function revoke(nonceHash: string) {
    assertDomain(HASH.test(nonceHash), 'INVALID_ARGUMENT', 'Session hash is invalid')
    await dependencies.sessions.revokeSession({ nonceHash, revokedAt: (dependencies.now?.() ?? new Date()).toISOString() })
  }
}

export function reserveUiLoginAttemptService(dependencies: {
  sessions: UiSessionSecurityRepository
  id: () => string
  now?: () => Date
}) {
  return async function reserve(input: { keyHash: string; subjectHash: string; requestId: string }) {
    assertDomain(HASH.test(input.keyHash) && HASH.test(input.subjectHash), 'INVALID_ARGUMENT', 'Login privacy hashes are invalid')
    assertDomain(REQUEST_ID.test(input.requestId), 'INVALID_ARGUMENT', 'Login request ID is invalid')
    return dependencies.sessions.reserveLoginAttempt({
      attemptId: dependencies.id(), keyHash: input.keyHash, subjectHash: input.subjectHash,
      requestId: input.requestId, occurredAt: (dependencies.now?.() ?? new Date()).toISOString(),
      windowMs: UI_LOGIN_WINDOW_MS, maxAttempts: UI_LOGIN_MAX_ATTEMPTS,
    })
  }
}

export function settleUiLoginAttemptService(dependencies: { sessions: UiSessionSecurityRepository; now?: () => Date }) {
  return async function settle(attemptId: string, outcome: UiLoginAttemptOutcome) {
    assertDomain(/^[0-9a-f-]{36}$/.test(attemptId), 'INVALID_ARGUMENT', 'Login attempt ID is invalid')
    await dependencies.sessions.settleLoginAttempt({ attemptId, outcome, settledAt: (dependencies.now?.() ?? new Date()).toISOString() })
  }
}
