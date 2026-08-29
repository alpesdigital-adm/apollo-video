import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ProviderJob } from '../../domain/provider-job.ts'

export interface PersistedProviderJob {
  job: Readonly<ProviderJob>
  requestFingerprint: string
}

export interface ClaimedProviderJob extends PersistedProviderJob {
  lease: Readonly<{ owner: string; token: string; expiresAt: string }>
}

export interface ProviderJobRepository {
  findReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedProviderJob> | null>
  create(input: {
    job: Readonly<ProviderJob>
    requestFingerprint: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    transitionId: string
  }): Promise<Readonly<{ persisted: Readonly<PersistedProviderJob>; replayed: boolean }>>
  read(input: {
    workspaceId: string
    projectId: string
    jobId: string
  }): Promise<Readonly<PersistedProviderJob> | null>
  claimNext(input: {
    workerId: string
    leaseToken: string
    now: Date
    leaseExpiresAt: Date
  }): Promise<Readonly<ClaimedProviderJob> | null>
  beginSubmission(input: {
    current: Readonly<ClaimedProviderJob>
    next: Readonly<ProviderJob>
    transitionId: string
    occurredAt: Date
  }): Promise<Readonly<ClaimedProviderJob>>
  advance(input: {
    current: Readonly<ClaimedProviderJob>
    next: Readonly<ProviderJob>
    transitionId: string
    occurredAt: Date
  }): Promise<Readonly<PersistedProviderJob>>
}
