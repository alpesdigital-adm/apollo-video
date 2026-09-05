import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'

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

const once = process.argv.includes('--once')
const pollIntervalMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('APOLLO_V2_WORKER_POLL_MS must be an integer of at least 100ms')
}

const workerId = `capture-sync:${hostname().slice(0, 32)}:${process.pid}:${randomUUID()}`
const runNext = createCaptureSyncWorker()

if (once) {
  const outcome = await runNext(workerId)
  // The worker's own result cannot distinguish a run that was settled with a
  // verdict from one settled as failed — both are `settled: true`. The row can,
  // so the row is read rather than the failure being inferred.
  const run = outcome.runId
    ? await createCaptureSyncRunRepository().read({
      workspaceId: outcome.workspaceId,
      runId: outcome.runId,
    })
    : null
  process.stdout.write(`APOLLO_CAPTURE_SYNC_OUTCOME=${JSON.stringify({
    ...outcome,
    status: run?.status ?? null,
    failureReason: run?.failureReason ?? null,
  })}\n`)
  // Nothing to claim is success: the queue being empty is the steady state, and
  // a replay of this command must not invent work or a failure.
  const healthy = !outcome.claimed || (outcome.settled && run?.status !== 'failed')
  process.exit(healthy ? 0 : 1)
}

let stopping = false
process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })

while (!stopping) {
  try {
    const outcome = await runNext(workerId)
    if (outcome.claimed) {
      console.info(JSON.stringify({
        runId: outcome.runId,
        settled: outcome.settled,
        resolved: outcome.resolved,
        review: outcome.review,
        insufficient: outcome.insufficient,
        coverageDerived: outcome.coverageDerived,
        coverageRefused: outcome.coverageRefused,
        ...(outcome.abandonedBecause ? { abandonedBecause: outcome.abandonedBecause } : {}),
      }))
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  } catch {
    // Same shape as the other drivers: one iteration failing must not take the
    // worker down, because the run it was holding is already back in the queue
    // once its lease expires.
    console.error('Capture sync worker iteration failed safely')
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}
