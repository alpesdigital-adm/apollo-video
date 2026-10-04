/**
 * Bounded poller for the persisted project administration event feed.
 *
 * It has no DOM or React dependency so its timing, backoff and shutdown rules
 * can be proven with a fake clock. The event payload is only a signal that the
 * dashboard read model is stale: this module never builds card data.
 */

export const PROJECT_EVENT_FEED_POLICY = Object.freeze({
  /** Delay between successful polls. */
  intervalMs: 4_000,
  /** Failure `n` waits `intervalMs * 2^n`, never more than this. */
  maxBackoffMs: 30_000,
  /** Consecutive failures after which the poller stops by itself. */
  maxConsecutiveFailures: 4,
  /** Delay before reading the next page when the previous one was full. */
  continuationDelayMs: 250,
  pageLimit: 50,
})

export type ProjectEventFeedPolicy = typeof PROJECT_EVENT_FEED_POLICY

export const PROJECT_EVENT_FEED_RELEVANT_TYPES: ReadonlySet<string> = new Set([
  'project.created',
  'project.name.changed',
  'project.status.changed',
])

export type ProjectEventFeedResult =
  | { kind: 'page'; eventTypes: readonly string[]; nextCursor: string; hasMore: boolean }
  | { kind: 'unauthorized' }
  | { kind: 'cursor-rejected' }
  | { kind: 'error' }

export interface ProjectEventFeedTransport {
  read(input: {
    after: string | undefined
    limit: number
    signal: AbortSignal
  }): Promise<ProjectEventFeedResult>
}

export type ProjectEventFeedStopReason = 'unauthorized' | 'retry-limit'

export interface ProjectEventFeedControllerDependencies {
  transport: ProjectEventFeedTransport
  onRelevantEvent(): void
  onUnauthorized(): void
  onStopped?(reason: ProjectEventFeedStopReason): void
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
  isVisible(): boolean
  /** Calls back on every visibility change; returns the unsubscribe. */
  subscribeVisibility(callback: () => void): () => void
  policy?: ProjectEventFeedPolicy
}

export interface ProjectEventFeedController {
  start(): void
  stop(): void
}

export function projectEventFeedBackoffMs(
  consecutiveFailures: number,
  policy: ProjectEventFeedPolicy = PROJECT_EVENT_FEED_POLICY,
): number {
  return Math.min(
    policy.intervalMs * 2 ** consecutiveFailures,
    policy.maxBackoffMs,
  )
}

export function createProjectEventFeedController(
  dependencies: ProjectEventFeedControllerDependencies,
): ProjectEventFeedController {
  const policy = dependencies.policy ?? PROJECT_EVENT_FEED_POLICY
  let cursor: string | undefined
  let failures = 0
  let timer: unknown
  let inFlight: AbortController | undefined
  let generation = 0
  let started = false
  let disposed = false
  let exhausted = false
  let unsubscribe: (() => void) | undefined

  function clearTimer() {
    if (timer !== undefined) dependencies.clearTimer(timer)
    timer = undefined
  }

  function cancelInFlight() {
    generation += 1
    inFlight?.abort()
    inFlight = undefined
  }

  function schedule(delayMs: number) {
    clearTimer()
    if (!started || disposed || exhausted || !dependencies.isVisible()) return
    timer = dependencies.setTimer(() => { void tick() }, delayMs)
  }

  async function tick() {
    timer = undefined
    if (!started || disposed || exhausted || inFlight || !dependencies.isVisible()) return
    const abort = new AbortController()
    inFlight = abort
    const ownGeneration = generation
    let result: ProjectEventFeedResult
    try {
      result = await dependencies.transport.read({
        after: cursor, limit: policy.pageLimit, signal: abort.signal,
      })
    } catch {
      result = { kind: 'error' }
    }
    if (ownGeneration !== generation || abort.signal.aborted) return
    inFlight = undefined
    if (!started || disposed) return

    if (result.kind === 'unauthorized') {
      disposed = true
      clearTimer()
      dependencies.onUnauthorized()
      dependencies.onStopped?.('unauthorized')
      return
    }
    const hadCursor = cursor !== undefined
    if (result.kind === 'cursor-rejected' && hadCursor) {
      // The server cannot vouch for our position: follow the head again and
      // refetch once, because events may have been missed.
      cursor = undefined
      failures = 0
      dependencies.onRelevantEvent()
      schedule(policy.intervalMs)
      return
    }
    if (result.kind === 'page') {
      failures = 0
      const relevant = hadCursor &&
        result.eventTypes.some((type) => PROJECT_EVENT_FEED_RELEVANT_TYPES.has(type))
      cursor = result.nextCursor
      if (relevant) dependencies.onRelevantEvent()
      schedule(result.hasMore ? policy.continuationDelayMs : policy.intervalMs)
      return
    }
    failures += 1
    if (failures >= policy.maxConsecutiveFailures) {
      exhausted = true
      clearTimer()
      dependencies.onStopped?.('retry-limit')
      return
    }
    schedule(projectEventFeedBackoffMs(failures, policy))
  }

  function onVisibilityChange() {
    if (!started || disposed) return
    if (!dependencies.isVisible()) {
      clearTimer()
      cancelInFlight()
      return
    }
    // Back in the foreground: a fresh failure budget and an immediate poll
    // that delivers whatever happened while the tab was hidden.
    exhausted = false
    failures = 0
    clearTimer()
    cancelInFlight()
    void tick()
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      unsubscribe = dependencies.subscribeVisibility(onVisibilityChange)
      if (dependencies.isVisible()) void tick()
    },
    stop() {
      disposed = true
      started = false
      clearTimer()
      cancelInFlight()
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
