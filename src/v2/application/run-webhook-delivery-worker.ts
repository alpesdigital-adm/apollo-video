import { DomainError, assertDomain } from '../domain/errors.ts'

type ClaimWebhookDelivery = (request: {
  workspaceId: string
  leaseOwner: string
}) => Promise<Readonly<{
  delivery: Readonly<{ id: string }>
  attempt: Readonly<{ attemptNumber: number }>
  leaseToken: string
}> | null>

type HeartbeatWebhookDelivery = (request: {
  workspaceId: string
  deliveryId: string
  leaseOwner: string
  leaseToken: string
  attemptNumber: number
}) => Promise<boolean>

type DispatchWebhookDelivery = (request: {
  workspaceId: string
  deliveryId: string
  leaseOwner: string
  leaseToken: string
  attemptNumber: number
}) => Promise<Readonly<{
  status: 'succeeded' | 'retry-scheduled' | 'dead-lettered' | 'stale'
}>>

export interface WebhookDeliveryWorkerOutcome {
  workspaceId: string
  deliveryId: string
  attemptNumber: number
  status: 'succeeded' | 'retry-scheduled' | 'dead-lettered' | 'lease-lost'
}

export function runNextWebhookDeliveryService(dependencies: {
  claim: ClaimWebhookDelivery
  heartbeat: HeartbeatWebhookDelivery
  dispatch: DispatchWebhookDelivery
  heartbeatIntervalMs?: number
}) {
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000
  assertDomain(
    Number.isSafeInteger(heartbeatIntervalMs) &&
      heartbeatIntervalMs >= 100 &&
      heartbeatIntervalMs <= 60_000,
    'INVALID_WEBHOOK',
    'Webhook worker heartbeat interval must be between 100 and 60000 milliseconds',
  )

  return async function runNextWebhookDelivery(request: {
    workspaceId: string
    leaseOwner: string
  }): Promise<Readonly<WebhookDeliveryWorkerOutcome> | null> {
    const claimed = await dependencies.claim(request)
    if (!claimed) return null

    const command = {
      workspaceId: request.workspaceId,
      deliveryId: claimed.delivery.id,
      leaseOwner: request.leaseOwner,
      leaseToken: claimed.leaseToken,
      attemptNumber: claimed.attempt.attemptNumber,
    }
    let stopped = false
    let leaseLost = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined

    const heartbeat = async () => {
      if (stopped || leaseLost) return false
      if (renewal) return renewal
      renewal = (async () => {
        try {
          const renewed = await dependencies.heartbeat(command)
          if (!renewed) leaseLost = true
          return renewed
        } catch {
          leaseLost = true
          return false
        } finally {
          renewal = undefined
        }
      })()
      return renewal
    }
    const scheduleHeartbeat = () => {
      if (stopped || leaseLost) return
      timer = setTimeout(async () => {
        await heartbeat()
        scheduleHeartbeat()
      }, heartbeatIntervalMs)
      timer.unref?.()
    }
    const stopHeartbeat = async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (renewal) await renewal
    }

    try {
      scheduleHeartbeat()
      const dispatched = await dependencies.dispatch(command)
      if (dispatched.status === 'stale') {
        return Object.freeze({
          workspaceId: command.workspaceId,
          deliveryId: command.deliveryId,
          attemptNumber: command.attemptNumber,
          status: 'lease-lost' as const,
        })
      }
      return Object.freeze({
        workspaceId: command.workspaceId,
        deliveryId: command.deliveryId,
        attemptNumber: command.attemptNumber,
        status: dispatched.status,
      })
    } finally {
      await stopHeartbeat()
    }
  }
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function normalizeWorkspaceIds(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.trim())
  assertDomain(
    normalized.length >= 1 &&
      normalized.length <= 1_000 &&
      normalized.every((value) => SAFE_ID_PATTERN.test(value)) &&
      new Set(normalized).size === normalized.length,
    'INVALID_WEBHOOK',
    'Webhook worker requires 1 to 1000 unique workspace IDs',
  )
  return Object.freeze(normalized)
}

async function waitForPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

export async function runWebhookDeliveryWorkerLoop(dependencies: {
  runNext: (request: {
    workspaceId: string
    leaseOwner: string
  }) => Promise<Readonly<WebhookDeliveryWorkerOutcome> | null>
  workspaceIds: readonly string[]
  leaseOwner: string
  signal: AbortSignal
  pollIntervalMs?: number
  onOutcome?: (outcome: Readonly<WebhookDeliveryWorkerOutcome>) => void
  onIterationError?: (event: Readonly<{ workspaceId: string }>) => void
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const workspaceIds = normalizeWorkspaceIds(dependencies.workspaceIds)
  const leaseOwner = dependencies.leaseOwner.trim()
  const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000
  assertDomain(
    SAFE_ID_PATTERN.test(leaseOwner),
    'INVALID_WEBHOOK',
    'Webhook worker lease owner is invalid',
  )
  assertDomain(
    Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 100 && pollIntervalMs <= 60_000,
    'INVALID_WEBHOOK',
    'Webhook worker poll interval must be between 100 and 60000 milliseconds',
  )
  const wait = dependencies.wait ?? waitForPoll

  while (!dependencies.signal.aborted) {
    let processed = false
    for (const workspaceId of workspaceIds) {
      if (dependencies.signal.aborted) break
      try {
        const outcome = await dependencies.runNext({ workspaceId, leaseOwner })
        if (outcome) {
          processed = true
          try {
            dependencies.onOutcome?.(outcome)
          } catch {
            // Observability callbacks cannot control delivery execution.
          }
        }
      } catch {
        try {
          dependencies.onIterationError?.(Object.freeze({ workspaceId }))
        } catch {
          // Observability callbacks cannot stop other workspaces.
        }
      }
    }
    if (!processed && !dependencies.signal.aborted) {
      await wait(pollIntervalMs, dependencies.signal)
    }
  }
}

export async function runDiscoveredWebhookDeliveryWorkerLoop(dependencies: {
  discover: (request: {
    shardIndex: number
    shardCount: number
    scanLimit: number
    cursor?: string
  }) => Promise<Readonly<{ workspaceIds: readonly string[]; nextCursor?: string }>>
  runNext: (request: {
    workspaceId: string
    leaseOwner: string
  }) => Promise<Readonly<WebhookDeliveryWorkerOutcome> | null>
  shardIndex: number
  shardCount: number
  leaseOwner: string
  signal: AbortSignal
  scanLimit?: number
  pollIntervalMs?: number
  onOutcome?: (outcome: Readonly<WebhookDeliveryWorkerOutcome>) => void
  onIterationError?: (event: Readonly<{ workspaceId: string }>) => void
  onDiscoveryError?: () => void
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const scanLimit = dependencies.scanLimit ?? 100
  const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000
  const leaseOwner = dependencies.leaseOwner.trim()
  assertDomain(
    Number.isSafeInteger(dependencies.shardCount) &&
      dependencies.shardCount >= 1 &&
      dependencies.shardCount <= 1_024 &&
      Number.isSafeInteger(dependencies.shardIndex) &&
      dependencies.shardIndex >= 0 &&
      dependencies.shardIndex < dependencies.shardCount &&
      Number.isSafeInteger(scanLimit) &&
      scanLimit >= 1 &&
      scanLimit <= 500 &&
      Number.isSafeInteger(pollIntervalMs) &&
      pollIntervalMs >= 100 &&
      pollIntervalMs <= 60_000 &&
      SAFE_ID_PATTERN.test(leaseOwner),
    'INVALID_WEBHOOK',
    'Webhook discovery worker configuration is invalid',
  )
  const wait = dependencies.wait ?? waitForPoll

  while (!dependencies.signal.aborted) {
    let processed = false
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    const seenWorkspaceIds = new Set<string>()
    do {
      let page: Readonly<{ workspaceIds: readonly string[]; nextCursor?: string }>
      try {
        page = await dependencies.discover({
          shardIndex: dependencies.shardIndex,
          shardCount: dependencies.shardCount,
          scanLimit,
          ...(cursor ? { cursor } : {}),
        })
      } catch {
        try {
          dependencies.onDiscoveryError?.()
        } catch {
          // Observability callbacks cannot control discovery.
        }
        break
      }
      for (const workspaceId of page.workspaceIds) {
        if (dependencies.signal.aborted) break
        if (seenWorkspaceIds.has(workspaceId)) continue
        seenWorkspaceIds.add(workspaceId)
        try {
          const outcome = await dependencies.runNext({ workspaceId, leaseOwner })
          if (outcome) {
            processed = true
            try {
              dependencies.onOutcome?.(outcome)
            } catch {
              // Observability callbacks cannot control delivery execution.
            }
          }
        } catch {
          try {
            dependencies.onIterationError?.(Object.freeze({ workspaceId }))
          } catch {
            // Observability callbacks cannot stop other workspaces.
          }
        }
      }
      const nextCursor = dependencies.signal.aborted ? undefined : page.nextCursor
      if (nextCursor && (nextCursor === cursor || seenCursors.has(nextCursor))) {
        try {
          dependencies.onDiscoveryError?.()
        } catch {
          // Observability callbacks cannot control discovery.
        }
        cursor = undefined
      } else {
        if (nextCursor) seenCursors.add(nextCursor)
        cursor = nextCursor
      }
    } while (cursor)

    if (!processed && !dependencies.signal.aborted) {
      await wait(pollIntervalMs, dependencies.signal)
    }
  }
}

export async function runCoordinatedWebhookDeliveryWorkerLoop(dependencies: {
  claimShard: () => Promise<Readonly<{
    shardIndex: number
    shardCount: number
  }> | null>
  heartbeatShard: (lease: Readonly<{ shardIndex: number; shardCount: number }>) => Promise<boolean>
  releaseShard: (lease: Readonly<{ shardIndex: number; shardCount: number }>) => Promise<boolean>
  runAssignedShard: (assignment: Readonly<{
    shardIndex: number
    shardCount: number
    signal: AbortSignal
  }>) => Promise<void>
  signal: AbortSignal
  heartbeatIntervalMs?: number
  retryIntervalMs?: number
  onCoordinationError?: () => void
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000
  const retryIntervalMs = dependencies.retryIntervalMs ?? 1_000
  assertDomain(
    Number.isSafeInteger(heartbeatIntervalMs) &&
      heartbeatIntervalMs >= 1_000 &&
      heartbeatIntervalMs <= 60_000 &&
      Number.isSafeInteger(retryIntervalMs) &&
      retryIntervalMs >= 100 &&
      retryIntervalMs <= 60_000,
    'INVALID_WEBHOOK',
    'Webhook shard coordination loop configuration is invalid',
  )
  const wait = dependencies.wait ?? waitForPoll

  while (!dependencies.signal.aborted) {
    let lease: Readonly<{ shardIndex: number; shardCount: number }> | null = null
    try {
      lease = await dependencies.claimShard()
    } catch {
      notifyCoordinationError()
    }
    if (!lease) {
      if (!dependencies.signal.aborted) await wait(retryIntervalMs, dependencies.signal)
      continue
    }
    assertDomain(
      Number.isSafeInteger(lease.shardCount) &&
        lease.shardCount >= 1 &&
        lease.shardCount <= 1_024 &&
        Number.isSafeInteger(lease.shardIndex) &&
        lease.shardIndex >= 0 &&
        lease.shardIndex < lease.shardCount,
      'PERSISTENCE_CONFLICT',
      'Webhook shard coordinator returned an invalid assignment',
    )

    const assigned = new AbortController()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined
    const abortAssigned = () => assigned.abort()
    dependencies.signal.addEventListener('abort', abortAssigned, { once: true })
    const heartbeat = async () => {
      if (stopped || assigned.signal.aborted) return false
      if (renewal) return renewal
      renewal = (async () => {
        try {
          const renewed = await dependencies.heartbeatShard(lease!)
          if (!renewed) assigned.abort()
          return renewed
        } catch {
          notifyCoordinationError()
          assigned.abort()
          return false
        } finally {
          renewal = undefined
        }
      })()
      return renewal
    }
    const scheduleHeartbeat = () => {
      if (stopped || assigned.signal.aborted) return
      timer = setTimeout(async () => {
        await heartbeat()
        scheduleHeartbeat()
      }, heartbeatIntervalMs)
      timer.unref?.()
    }

    try {
      scheduleHeartbeat()
      await dependencies.runAssignedShard({
        shardIndex: lease.shardIndex,
        shardCount: lease.shardCount,
        signal: assigned.signal,
      })
    } catch {
      notifyCoordinationError()
    } finally {
      stopped = true
      if (timer) clearTimeout(timer)
      if (renewal) await renewal
      dependencies.signal.removeEventListener('abort', abortAssigned)
      try {
        await dependencies.releaseShard(lease)
      } catch {
        notifyCoordinationError()
      }
    }
    if (!dependencies.signal.aborted) await wait(retryIntervalMs, dependencies.signal)
  }

  function notifyCoordinationError() {
    try {
      dependencies.onCoordinationError?.()
    } catch {
      // Observability callbacks cannot control shard ownership.
    }
  }
}
