import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ProviderCallbackEvent, ProviderCallbackOutcome, ProviderCallbackRejection } from '../../domain/provider-job-callback.ts'
import type { ProviderJobTransportState } from '../../domain/provider-job-transport.ts'
import type { ProviderJob } from '../../domain/provider-job.ts'

export interface PersistedProviderJob {
  job: Readonly<ProviderJob>
  requestFingerprint: string
  /** Present for every job that declares a transport; absent for synthetic jobs. */
  transportState?: Readonly<ProviderJobTransportState> | null
}

export interface ClaimedProviderJob extends PersistedProviderJob {
  lease: Readonly<{ owner: string; token: string; expiresAt: string }>
}

export interface PersistedProviderCallbackEvent {
  event: Readonly<ProviderCallbackEvent>
  outcome: ProviderCallbackOutcome
  rejectionReason?: ProviderCallbackRejection
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
    /** Written with the job or not at all: a transport without a schedule is unreachable. */
    transportState?: Readonly<ProviderJobTransportState>
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
    /** Written in the same transaction as the transition, or not at all. */
    transportState?: Readonly<ProviderJobTransportState>
  }): Promise<Readonly<PersistedProviderJob>>

  /**
   * Route an inbound callback to the job it claims to be about. Keyed by the
   * provider's own identifier, because that is the only handle the provider has
   * — it has never seen an Apollo job id.
   */
  findByProviderCorrelation(input: {
    workspaceId: string
    adapterId: string
    providerJobId: string
  }): Promise<Readonly<PersistedProviderJob> | null>

  readTransportState(input: {
    workspaceId: string
    projectId: string
    jobId: string
  }): Promise<Readonly<ProviderJobTransportState> | null>

  /** Compare-and-swap on `revision`. A lost race raises VERSION_CONFLICT. */
  saveTransportState(input: {
    expectedRevision: number
    next: Readonly<ProviderJobTransportState>
  }): Promise<Readonly<ProviderJobTransportState>>

  /**
   * Persist the verdict on one inbound callback and, when it is accepted, wake
   * the job — in a single transaction, so a callback can never be recorded as
   * consumed without the effect it authorised.
   */
  recordCallbackEvent(input: {
    id: string
    event: Readonly<ProviderCallbackEvent>
    outcome: ProviderCallbackOutcome
    rejectionReason?: ProviderCallbackRejection
    projectId: string
    wake?: Readonly<{ expectedRevision: number; next: Readonly<ProviderJobTransportState> }>
  }): Promise<Readonly<PersistedProviderCallbackEvent>>

  findCallbackEvent(input: {
    workspaceId: string
    providerId: string
    eventId: string
  }): Promise<Readonly<ProviderCallbackEvent> | null>

  listCallbackEvents(input: {
    workspaceId: string
    projectId: string
    jobId: string
    limit?: number
  }): Promise<readonly Readonly<PersistedProviderCallbackEvent>[]>
}
