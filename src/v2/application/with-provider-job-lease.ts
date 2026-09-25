import type {
  ClaimedProviderJob,
  ProviderJobRepository,
} from './ports/provider-job-repository.ts'
import { DomainError } from '../domain/errors.ts'

export interface ProviderJobLeaseScheduler {
  set(delayMs: number, callback: () => void): unknown
  clear(handle: unknown): void
}

const runtimeScheduler: ProviderJobLeaseScheduler = Object.freeze({
  set: (delayMs: number, callback: () => void) => setTimeout(callback, delayMs),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Provider job work was aborted', 'AbortError')
}

/**
 * Keep one provider-job claim alive while a bounded, abortable operation runs.
 * The returned claim carries the latest expiry and must be used for settlement.
 */
export async function runWithProviderJobLease<T>(input: Readonly<{
  jobs: Pick<ProviderJobRepository, 'renewLease'>
  claim: Readonly<ClaimedProviderJob>
  clock: () => Date
  leaseMs: number
  renewalIntervalMs?: number
  signal?: AbortSignal
  scheduler?: ProviderJobLeaseScheduler
}>, callback: (context: Readonly<{ signal: AbortSignal }>) => Promise<T>): Promise<Readonly<{
  value: T
  claim: Readonly<ClaimedProviderJob>
}>> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new DomainError('INVALID_ARGUMENT', 'Provider lease duration must be a positive integer')
  }
  const renewalIntervalMs = input.renewalIntervalMs ?? Math.max(1, Math.floor(input.leaseMs / 3))
  if (!Number.isSafeInteger(renewalIntervalMs) || renewalIntervalMs <= 0 || renewalIntervalMs >= input.leaseMs) {
    throw new DomainError('INVALID_ARGUMENT', 'Provider lease renewal interval must be shorter than the lease')
  }
  if (input.signal?.aborted) throw abortReason(input.signal)

  const scheduler = input.scheduler ?? runtimeScheduler
  const controller = new AbortController()
  let claim = input.claim
  let stopped = false
  let timer: unknown
  let renewal: Promise<void> | null = null
  let leaseFailure: Error | null = null

  const forwardAbort = () => controller.abort(abortReason(input.signal!))
  if (input.signal?.aborted) forwardAbort()
  else input.signal?.addEventListener('abort', forwardAbort, { once: true })

  const scheduleRenewal = () => {
    if (stopped || controller.signal.aborted) return
    timer = scheduler.set(renewalIntervalMs, () => {
      timer = undefined
      if (stopped || controller.signal.aborted) return
      renewal = (async () => {
        const now = input.clock()
        claim = await input.jobs.renewLease({
          current: claim,
          now,
          leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        })
      })().catch((error: unknown) => {
        leaseFailure = error instanceof Error
          ? error
          : new DomainError('VERSION_CONFLICT', 'Provider job lease renewal failed')
        controller.abort(leaseFailure)
      }).finally(() => {
        renewal = null
        scheduleRenewal()
      })
    })
  }

  scheduleRenewal()
  let value: T | undefined
  let callbackFailure: unknown
  try {
    value = await callback(Object.freeze({ signal: controller.signal }))
  } catch (error) {
    callbackFailure = error
  } finally {
    stopped = true
    if (timer !== undefined) scheduler.clear(timer)
    const pendingRenewal = renewal
    if (pendingRenewal) await pendingRenewal
    input.signal?.removeEventListener('abort', forwardAbort)
  }

  // A callback may ignore AbortSignal or finish concurrently with a failed
  // heartbeat. It still cannot publish with an unproven lease.
  if (leaseFailure) throw leaseFailure
  if (input.signal?.aborted) throw abortReason(input.signal)
  if (callbackFailure !== undefined) throw callbackFailure
  return Object.freeze({ value: value as T, claim })
}
