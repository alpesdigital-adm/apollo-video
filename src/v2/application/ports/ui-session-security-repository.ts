import type { ApolloUiSession } from '../../domain/ui-session.ts'

export type UiLoginAttemptOutcome = 'succeeded' | 'invalid' | 'configuration-error'

export interface DurableUiSessionRecord {
  nonceHash: string
  workspaceId: string
  clientId: string
  subjectHash: string
  issuedAt: string
  lastSeenAt: string
  idleExpiresAt: string
  expiresAt: string
  revokedAt?: string
}

export interface UiSessionSecurityRepository {
  createSession(input: Readonly<{
    session: ApolloUiSession
    nonceHash: string
    subjectHash: string
    workspaceId: string
    idleTtlSeconds: number
  }>): Promise<Readonly<DurableUiSessionRecord>>
  readActiveAndTouch(input: Readonly<{ nonceHash: string; now: string; idleTtlSeconds: number }>): Promise<Readonly<DurableUiSessionRecord> | null>
  revokeSession(input: Readonly<{ nonceHash: string; revokedAt: string }>): Promise<void>
  reserveLoginAttempt(input: Readonly<{
    attemptId: string
    keyHash: string
    subjectHash: string
    requestId: string
    occurredAt: string
    windowMs: number
    maxAttempts: number
  }>): Promise<Readonly<{ allowed: boolean; attemptId?: string; retryAfterSeconds?: number }>>
  settleLoginAttempt(input: Readonly<{
    attemptId: string
    settledAt: string
    outcome: UiLoginAttemptOutcome
  }>): Promise<void>
}
