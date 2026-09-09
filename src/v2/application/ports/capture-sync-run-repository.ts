export type CaptureSyncRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'superseded'

export interface CaptureSyncRun {
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly sessionId: string
  /** The exact session version this run was requested against. */
  readonly baseVersionId: string
  readonly baseSessionHash: string
  readonly baseVersion: number
  readonly status: CaptureSyncRunStatus
  /** Strictly increasing per session. Only the highest may settle. */
  readonly fencingToken: bigint
  readonly attemptCount: number
  readonly maxAttempts: number
  readonly trackCount: number
  readonly resolvedCount: number | null
  readonly reviewCount: number | null
  readonly insufficientCount: number | null
  readonly failureReason: string | null
  readonly leaseExpiresAt: string | null
  readonly heartbeatAt: string | null
  readonly startedAt: string | null
  readonly settledAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** What a worker gets when it wins a claim: the run, and the token proving it. */
export interface CaptureSyncClaim {
  readonly run: Readonly<CaptureSyncRun>
  /** Held only by this worker. Presenting it again is what settles the run. */
  readonly leaseToken: string
}

/**
 * The durable synchronization run (F4.004/F4.006).
 *
 * The interface is shaped by one question: what happens to a worker that pauses
 * — for a long GC, a stalled disk, a hypervisor migration — long enough for its
 * lease to expire, has its work reclaimed by another worker, and then wakes up
 * and tries to write its result?
 *
 * Three things stop it, and the port exposes all three because a caller that
 * cannot see them cannot reason about them:
 *
 * `claim` hands back a lease token the caller must present to `settle`. The
 * stored side is a hash, so reading the table does not let anyone settle.
 *
 * `heartbeat` extends the lease and fails once the lease is gone, so a worker
 * discovers it has been overtaken while it still has work in hand rather than
 * at the end.
 *
 * `settle` requires the token *and* the fencing token to still be the highest
 * for that session. A lease is a timeout, and a paused process cannot be told
 * that it has been paused — the fencing token is what turns "probably still
 * mine" into a comparison.
 */
export interface CaptureSyncRunRepository {
  /**
   * Start a run, or rejoin the one this idempotency key already started.
   *
   * A retried request must not start a second pass over the same media, so the
   * key is unique per client and a replay returns the existing run.
   */
  request(input: {
    id: string
    workspaceId: string
    projectId: string
    sessionId: string
    baseVersionId: string
    baseSessionHash: string
    baseVersion: number
    trackCount: number
    idempotencyKey: string
    createdByClientId: string
    requestedAt: string
  }): Promise<Readonly<{ run: Readonly<CaptureSyncRun>; replayed: boolean }>>

  read(input: {
    workspaceId: string
    runId: string
  }): Promise<Readonly<CaptureSyncRun> | null>

  /** The newest run for a session, whatever its state. */
  readLatestForSession(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<CaptureSyncRun> | null>

  /**
   * Take the oldest claimable run: queued, or running with an expired lease.
   *
   * Reclaiming an expired lease is not a failure mode, it is the recovery path.
   * A worker that died holding a lease must not block its session forever.
   */
  claim(input: {
    owner: string
    now: string
    leaseMs: number
  }): Promise<Readonly<CaptureSyncClaim> | null>

  /** Extend a lease. Returns false once the lease is gone — do not keep working. */
  heartbeat(input: {
    workspaceId: string
    runId: string
    leaseToken: string
    now: string
    leaseMs: number
  }): Promise<boolean>

  /**
   * Finish a run.
   *
   * Refused when the token no longer matches or a newer run exists for the
   * session: a result computed against a session that has since moved is not a
   * late result, it is the wrong result.
   */
  settle(input: {
    workspaceId: string
    runId: string
    leaseToken: string
    now: string
    outcome:
      | Readonly<{ status: 'succeeded'; resolvedCount: number; reviewCount: number; insufficientCount: number }>
      | Readonly<{ status: 'failed'; failureReason: string }>
  }): Promise<Readonly<{ settled: boolean; run: Readonly<CaptureSyncRun> | null; reason?: 'lease-lost' | 'superseded' | 'not-running' }>>
}
