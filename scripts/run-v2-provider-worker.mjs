import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedProviderJobs from '../src/v2/application/provider-jobs.ts'
import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'

const providerJobs = importedProviderJobs.runProviderJobWorkerLoop
  ? importedProviderJobs
  : importedProviderJobs.default
const repositoryFactory = importedRepositoryFactory.createProviderJobWorker
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default
const lifecycle = importedLifecycle.createWorkerShutdown
  ? importedLifecycle
  : importedLifecycle.default
const {
  WORKER_SHUTDOWN_DEADLINE_EXIT_CODE,
  awaitWithShutdownDeadline,
  createWorkerShutdown,
  isShutdownDeadlineError,
  resolveWorkerShutdownGraceMs,
  runWithCleanup,
} = lifecycle
const opsState = importedOpsState.createFileAdmissionGate
  ? importedOpsState
  : importedOpsState.default
const { createFileAdmissionGate } = opsState

process.env.APOLLO_PROCESS_ROLE ??= 'provider-worker'

const pollIntervalMs = Number(process.env.APOLLO_V2_PROVIDER_POLL_MS ?? process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
  throw new Error('APOLLO_V2_PROVIDER_POLL_MS must be between 100 and 60000ms')
}

const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)

const host = hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 36) || 'unknown-host'
const workerId = `provider:${host}:${process.pid}:${randomUUID()}`
const runNext = repositoryFactory.createProviderJobWorker(process.env)
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'provider', ...event })),
})

// A closed gate stops the next claim and nothing else. Provider jobs in
// `submitting` are the one status that must never be re-driven blindly — the
// submission may already have been accepted and charged — and the fence for that
// lives in `provider-jobs.ts`, untouched here: shutdown never authorises a
// resubmission, it only declines to start another job.
//
// The whole loop is guarded rather than each claim, because this loop lives in the
// application layer and already exits on the abort: what is left to bound is the one
// claim that is mid-flight when the abort arrives.
const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: 'provider', ...event })),
})

try {
  await runWithCleanup(
    () => guard('provider-job', providerJobs.runProviderJobWorkerLoop({
      workerId,
      runNext,
      signal: shutdown.signal,
      pollIntervalMs,
      admits: async () => (await shutdown.admits()).admits,
      onIterationError: () => console.error('Provider worker iteration failed safely'),
    })),
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'prisma-disconnect', run: () => prismaClient.disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: 'provider', ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
