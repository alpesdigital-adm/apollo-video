import type { ApolloUiSession } from '../../domain/ui-session.ts'
import type { ApiEnvironment } from '../../domain/api-client.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

export type UiLoginAttemptOutcome = 'succeeded' | 'invalid' | 'configuration-error'

export interface DurableUiSessionRecord {
  nonceHash: string
  workspaceId: string
  clientId: string
  memberId: string
  memberRole: WorkspaceMemberRole
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
    memberId: string
    idleTtlSeconds: number
  }>): Promise<Readonly<DurableUiSessionRecord>>
  readActiveAndTouch(input: Readonly<{ nonceHash: string; now: string; idleTtlSeconds: number }>): Promise<Readonly<DurableUiSessionRecord> | null>
  revokeSession(input: Readonly<{ nonceHash: string; revokedAt: string }>): Promise<void>
  rotateSession(input: Readonly<{
    currentNonceHash: string
    session: ApolloUiSession
    nonceHash: string
    subjectHash: string
    workspaceId: string
    clientId: string
    memberId: string
    environment: ApiEnvironment
    idleTtlSeconds: number
    now: string
  }>): Promise<Readonly<DurableUiSessionRecord>>
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
