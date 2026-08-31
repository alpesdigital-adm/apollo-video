/**
 * Mutual exclusion over one cache address, for the window in which a decision
 * to pay has been taken but the pending generation that records it is not yet
 * visible to anyone else.
 *
 * Without it, "is a twin already in flight?" is a read followed by a write, and
 * two requests that ask at the same instant both read "no" and both pay. The
 * claim is not a lock held across provider work: it is released as soon as the
 * pending row exists, and provider calls happen later, in the worker.
 */
export interface SyntheticCacheSubmissionClaimRepository {
  /**
   * Takes the address, or reports that somebody else holds it.
   *
   * A claim older than `staleBefore` is taken over: a process that died between
   * claiming and creating its generation must not wedge the address forever.
   * Returns true only when the caller owns the address.
   */
  claim(input: {
    workspaceId: string
    cacheKey: string
    blockId: string
    now: Date
    staleBefore: Date
  }): Promise<boolean>

  /**
   * Gives the address back. Releasing is scoped to the holder, so a caller
   * whose stale claim was taken over cannot free the new holder's claim.
   */
  release(input: {
    workspaceId: string
    cacheKey: string
    blockId: string
  }): Promise<void>
}
