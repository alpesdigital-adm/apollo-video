import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

/**
 * The consumer `capture_sync_runs` never had (map §19.1).
 *
 * `POST .../sync-runs` has enqueued rows since Wave 18 and nothing in
 * production dequeued them: `runCaptureSyncWorker` was called only from tests
 * and no script existed. This is the driver, shaped like
 * `run-v2-render-worker.mjs` — same env, same owner id, same graceful stop —
 * with one addition it needs and the render worker does not.
 *
 * `--once` processes at most one run and exits, which is what CI and the
 * persistence E2E can actually assert against: a loop that polls forever has no
 * moment at which "the queue is empty" is observable. An empty queue exits 0
 * and writes nothing, so running it twice is a replay rather than a second
 * pass.
 */

const repositoryFactory = importedRepositoryFactory.createCaptureSyncWorker
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const { createCaptureSyncWorker, createCaptureSyncRunRepository } = repositoryFactory
const lifecycle = importedLifecycle.createWorkerShutdown
  ? importedLifecycle
  : importedLifecycle.default
const { createWorkerShutdown, runWithCleanup } = lifecycle
const opsState = importedOpsState.createFileAdmissionGate
  ? importedOpsState
  : importedOpsState.default
const { createFileAdmissionGate } = opsState
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default
const { disconnectV2PostgresClient } = prismaClient

process.env.APOLLO_PROCESS_ROLE ??= 'capture-sync-worker'

const once = process.argv.includes('--once')
const pollIntervalMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('APOLLO_V2_WORKER_POLL_MS must be an integer of at least 100ms')
}

const workerId = `capture-sync:${hostname().slice(0, 32)}:${process.pid}:${randomUUID()}`
const runNext = createCaptureSyncWorker()
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'capture-sync', ...event })),
})
const cleanups = [
  { name: 'shutdown-listeners', run: () => shutdown.dispose() },
  { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
]
const onCleanupFailure = (event) =>
  console.error(JSON.stringify({ worker: 'capture-sync', ...event, error: String(event.error) }))

const emptyOutcome = {
  claimed: null,
  settled: false,
  status: null,
  failureReason: null,
}

if (once) {
  // Wrapped because the alternative is an unhandled rejection: this is
  // top-level `await` in a module, so anything the worker lets escape kills the
  // process with a stack trace and no outcome line, and CI reads the outcome
  // line. The run it was holding is already back in the queue once its lease
  // expires, which is the recovery this exit code reports rather than performs.
  try {
    const result = await runWithCleanup(
      async () => {
        const admission = await shutdown.admits()
        if (!admission.admits) return { refused: admission.reason }
        const outcome = await runNext(workerId, shutdown.signal)
        // The worker's own result cannot distinguish a run that was settled with a
        // verdict from one settled as failed — both are `settled: true`. The row can,
        // so the row is read rather than the failure being inferred.
        const run = outcome.runId
          ? await createCaptureSyncRunRepository().read({
            workspaceId: outcome.workspaceId,
            runId: outcome.runId,
          })
          : null
        return {
          refused: null,
          payload: {
            ...outcome,
            status: run?.status ?? null,
            failureReason: run?.failureReason ?? null,
          },
          // Nothing to claim is success: the queue being empty is the steady state, and
          // a replay of this command must not invent work or a failure.
          healthy: !outcome.claimed || (outcome.settled && run?.status !== 'failed'),
        }
      },
      cleanups,
      onCleanupFailure,
    )
    if (result.refused) {
      // A refused admission is not a failed run: the queue was never read, so the
      // exit code says "nothing to report", the same as an empty queue.
      process.stdout.write(`APOLLO_CAPTURE_SYNC_OUTCOME=${JSON.stringify({
        ...emptyOutcome,
        failureReason: `admission refused: ${result.refused}`,
      })}\n`)
      process.exit(0)
    }
    process.stdout.write(`APOLLO_CAPTURE_SYNC_OUTCOME=${JSON.stringify(result.payload)}\n`)
    process.exit(result.healthy ? 0 : 1)
  } catch (error) {
    process.stdout.write(`APOLLO_CAPTURE_SYNC_OUTCOME=${JSON.stringify({
      ...emptyOutcome,
      failureReason: error instanceof Error ? error.message : String(error),
    })}\n`)
    console.error(error)
    process.exit(1)
  }
}

function waitForPoll() {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout)
      shutdown.signal.removeEventListener('abort', finish)
      resolve()
    }
    const timeout = setTimeout(finish, pollIntervalMs)
    shutdown.signal.addEventListener('abort', finish, { once: true })
  })
}

await runWithCleanup(
  async () => {
    while (!shutdown.stopping()) {
      try {
        const admission = await shutdown.admits()
        if (!admission.admits) {
          if (!shutdown.stopping()) await waitForPoll()
          continue
        }
        const outcome = await runNext(workerId, shutdown.signal)
        if (outcome.claimed) {
          console.info(JSON.stringify({
            runId: outcome.runId,
            settled: outcome.settled,
            resolved: outcome.resolved,
            review: outcome.review,
            insufficient: outcome.insufficient,
            coverageDerived: outcome.coverageDerived,
            coverageRefused: outcome.coverageRefused,
            mapRefused: outcome.mapRefused,
            mediaUnavailable: outcome.mediaUnavailable,
            ...(outcome.abandonedBecause ? { abandonedBecause: outcome.abandonedBecause } : {}),
          }))
        } else if (!shutdown.stopping()) {
          await waitForPoll()
        }
      } catch {
        // Same shape as the other drivers: one iteration failing must not take the
        // worker down, because the run it was holding is already back in the queue
        // once its lease expires.
        if (shutdown.stopping()) break
        console.error('Capture sync worker iteration failed safely')
        await waitForPoll()
      }
    }
  },
  cleanups,
  onCleanupFailure,
)
