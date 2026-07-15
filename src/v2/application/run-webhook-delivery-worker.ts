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
    timer.unref?.()
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
