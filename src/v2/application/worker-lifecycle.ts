import {
  ADMISSION_GATE_OPEN,
  alwaysAdmittingGate,
  type AdmissionGate,
  type AdmissionGateReading,
} from './ports/admission-gate.ts'

/**
 * The four things every worker entrypoint needs and none of them should hand-roll
 * again (Wave 23, slice D). Not a framework: no loop, no scheduler, no heartbeat.
 *
 * Wave 23's Gate Zero inventory found three scripts stopping on a bare boolean
 * flag (`let stopping = false`), which is only checked between loop iterations —
 * so a SIGTERM arriving during a multi-minute encode was not observed until the
 * claim settled, and the most rigorously fenced branch in the repository
 * (`run-public-operation-worker.ts`) could not be reached by SIGINT at all
 * because nothing threaded a signal into it. Four scripts also left Prisma to be
 * torn down by process exit, which is how the 29 July 2026 orphan-connection
 * incident started.
 *
 * `terminateChild` exists because "stop the encode" and "stop every ffmpeg on
 * this host" are different operations and only the first is ever correct: a run
 * may only end processes it owns, identified by the handle it holds, never by
 * scanning the machine.
 */
export const WORKER_SHUTDOWN_ERROR_CODE = 'worker_shutdown'

/**
 * The failure recorded when a graceful shutdown interrupts an admitted attempt.
 *
 * Retryable on purpose. An operator stopping a worker is not the operation
 * failing and not the user cancelling it: `retryOrFailPublicOperation`
 * (src/v2/domain/public-operation.ts) turns a retryable error with attempts left
 * into `retrying` with `deadLetteredAt` cleared, and the repository's
 * `transitionRunning` clears `leaseOwner`/`leaseExpiresAt` for any non-running
 * status — which is exactly the shape `claimNext` looks for
 * (`{ status: 'retrying', leaseOwner: null, nextAttemptAt: { lte: now } }`), so
 * another worker takes it over without waiting out the lease.
 */
export function workerShutdownFailure(): Readonly<{
  code: string
  message: string
  retryable: true
}> {
  return Object.freeze({
    code: WORKER_SHUTDOWN_ERROR_CODE,
    message: 'Worker shut down before the attempt finished',
    retryable: true as const,
  })
}

/**
 * The earliest `nextAttemptAt` the domain accepts.
 *
 * `retryOrFailPublicOperation` asserts `nextAttemptAt > updatedAt` strictly, so a
 * shutdown cannot say "now"; one millisecond later is the smallest value that
 * satisfies the invariant and still makes the row claimable on the next poll.
 */
export function immediateNextAttemptAt(failedAt: Date): string {
  return new Date(failedAt.getTime() + 1).toISOString()
}

export interface AbortSignalLink {
  /** Removes the listener. Idempotent. */
  dispose(): void
}

/**
 * Forwards an outer abort into an inner controller, once, with removal.
 *
 * Removal matters because the outer signal outlives the claim: a worker that
 * loops for days would otherwise accumulate one listener per iteration on the
 * same process-level signal.
 */
export function linkAbortSignal(
  outer: AbortSignal | undefined,
  inner: AbortController,
): AbortSignalLink {
  if (!outer) return Object.freeze({ dispose: () => undefined })
  const forward = () => inner.abort(outer.reason)
  if (outer.aborted) {
    forward()
    return Object.freeze({ dispose: () => undefined })
  }
  outer.addEventListener('abort', forward, { once: true })
  let disposed = false
  return Object.freeze({
    dispose: () => {
      if (disposed) return
      disposed = true
      outer.removeEventListener('abort', forward)
    },
  })
}

export interface TerminableChild {
  readonly pid?: number | undefined
  readonly exitCode?: number | null
  readonly signalCode?: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown
  off?(event: 'exit', listener: (...args: unknown[]) => void): unknown
}

export interface TerminateChildResult {
  /** True when SIGKILL was needed because the grace window elapsed. */
  readonly escalated: boolean
  /** True when the child had already exited before the first signal. */
  readonly alreadyExited: boolean
}

/**
 * Ends one child process this run owns and waits for its real exit.
 *
 * Handle-based by construction: the `ChildProcess` object is the identity, so a
 * PID recycled by the operating system between the signal and the wait cannot be
 * hit. Never `pkill`, never a name scan, never a process group — a shared host
 * runs other people's ffmpeg too.
 *
 * SIGTERM first so the child can flush and remove its partial output, SIGKILL
 * only after the grace window, and the returned promise settles on the `exit`
 * event rather than on the signal being sent, because a signal delivered is not
 * a process ended.
 */
export async function terminateChild(
  child: TerminableChild,
  options: { graceMs: number; signal?: NodeJS.Signals },
): Promise<Readonly<TerminateChildResult>> {
  const graceMs = options.graceMs
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('terminateChild requires a non-negative integer graceMs')
  }
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return Object.freeze({ escalated: false, alreadyExited: true })
  }
  if (child.signalCode) {
    return Object.freeze({ escalated: false, alreadyExited: true })
  }

  let exited = false
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve()
    })
  })

  child.kill(options.signal ?? 'SIGTERM')

  let escalated = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs)
    timer.unref?.()
  })
  await Promise.race([exit, grace])
  if (timer) clearTimeout(timer)
  if (!exited) {
    escalated = true
    child.kill('SIGKILL')
    // No second deadline: SIGKILL is not refusable, and inventing a timeout here
    // would let the caller continue while the child still holds its output file.
    await exit
  }
  return Object.freeze({ escalated, alreadyExited: false })
}

export interface CleanupFailure {
  readonly name: string
  readonly error: unknown
}

export interface ErrorWithCleanupFailures extends Error {
  cleanupErrors?: readonly Readonly<CleanupFailure>[]
}

export interface WorkerCleanup {
  readonly name: string
  run(): Promise<void> | void
}

/**
 * Runs `primary`, then every cleanup, and loses neither outcome.
 *
 * The primary error wins — a failed `$disconnect` must never be what an operator
 * reads instead of the render failure that caused it — but cleanup failures are
 * attached as `cleanupErrors` and handed to `log` instead of being swallowed,
 * because "the tunnel was closed" and "closing the tunnel threw" are the two
 * facts a postflight has to distinguish.
 */
export async function runWithCleanup<T>(
  primary: () => Promise<T>,
  cleanups: readonly WorkerCleanup[],
  log: (event: Readonly<{ event: string; reason?: string | null; error?: unknown }>) => void =
    () => undefined,
): Promise<T> {
  let primaryError: unknown
  let result: T | undefined
  try {
    result = await primary()
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors: CleanupFailure[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup.run()
    } catch (error) {
      cleanupErrors.push(Object.freeze({ name: cleanup.name, error }))
      log({ event: 'worker-cleanup-failed', reason: cleanup.name, error })
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length && primaryError instanceof Error) {
      ;(primaryError as ErrorWithCleanupFailures).cleanupErrors = Object.freeze(cleanupErrors)
    }
    throw primaryError
  }
  if (cleanupErrors.length) {
    const failure = new Error(
      `Worker cleanup failed: ${cleanupErrors.map((entry) => entry.name).join(', ')}`,
    ) as ErrorWithCleanupFailures
    failure.cleanupErrors = Object.freeze(cleanupErrors)
    throw failure
  }
  return result as T
}

export interface WorkerShutdown {
  /** Aborted on the first SIGINT/SIGTERM. Pass it into every `runNext`. */
  readonly signal: AbortSignal
  /** The signal name that stopped the worker, or null while it is running. */
  readonly reason: string | null
  /** True once a stop signal has been observed. */
  stopping(): boolean
  /**
   * The gate reading to use before the next claim. Returns a refusal as soon as a
   * stop signal has arrived, so a caller needs one check rather than two.
   */
  admits(): Promise<Readonly<AdmissionGateReading>>
  /** Removes the process listeners. Safe to call more than once. */
  dispose(): void
}

export interface WorkerShutdownProcess {
  once(event: string, listener: (...args: never[]) => void): unknown
  off?(event: string, listener: (...args: never[]) => void): unknown
  removeListener?(event: string, listener: (...args: never[]) => void): unknown
}

/**
 * One AbortController wired to SIGINT/SIGTERM, plus the gate reading a loop needs
 * between claims.
 *
 * Signals are registered with `once` and both handlers are removed by `dispose`,
 * so a second SIGTERM from an impatient supervisor does not re-enter the
 * shutdown path, and the listener does not outlive the process's own teardown.
 *
 * Gate transitions are logged once each: a worker idling behind a closed gate for
 * an hour must not produce an hour of identical lines, and a worker that resumes
 * must say so.
 */
export function createWorkerShutdown(dependencies: {
  process: WorkerShutdownProcess
  gate?: AdmissionGate
  log?: (event: Readonly<{ event: string; reason?: string | null }>) => void
  signals?: readonly string[]
}): WorkerShutdown {
  const gate = dependencies.gate ?? alwaysAdmittingGate
  const log = dependencies.log ?? (() => undefined)
  const controller = new AbortController()
  const names = dependencies.signals ?? ['SIGINT', 'SIGTERM']
  let reason: string | null = null
  let lastGateReason: string | null | undefined
  let noted = false

  const handlers = names.map((name) => {
    const handler = () => {
      if (reason === null) {
        reason = name
        log({ event: 'worker-shutdown-requested', reason: name })
      }
      controller.abort(new Error(`Worker received ${name}`))
    }
    dependencies.process.once(name, handler as (...args: never[]) => void)
    return { name, handler }
  })

  let disposed = false

  return Object.freeze({
    signal: controller.signal,
    get reason() {
      return reason
    },
    stopping: () => controller.signal.aborted,
    admits: async () => {
      if (controller.signal.aborted) {
        return Object.freeze({ admits: false, reason: `shutdown:${reason ?? 'signal'}` })
      }
      const reading = await gate.read()
      if (reading.admits && reading.reason === 'ops-state-not-configured') {
        // Said once, at the first claim, so an operator reading a worker's log
        // can tell "no contract configured" from "contract says go".
        if (!noted) {
          noted = true
          log({ event: 'worker-admission-gate-absent', reason: reading.reason })
        }
        lastGateReason = null
        return ADMISSION_GATE_OPEN
      }
      if (reading.reason !== lastGateReason) {
        lastGateReason = reading.reason
        log({
          event: reading.admits ? 'worker-admission-gate-open' : 'worker-admission-gate-closed',
          reason: reading.reason,
        })
      }
      return reading
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const { name, handler } of handlers) {
        const remove = dependencies.process.off ?? dependencies.process.removeListener
        remove?.call(dependencies.process, name, handler as (...args: never[]) => void)
      }
    },
  })
}
