import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import repositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

const { createMediaIngestWorker } = repositoryFactory
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
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default
const { disconnectV2PostgresClient } = prismaClient

process.env.APOLLO_PROCESS_ROLE ??= 'ingest-worker'

const pollIntervalMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('APOLLO_V2_WORKER_POLL_MS must be an integer of at least 100ms')
}
const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)

const workerId = `ingest:${hostname().slice(0, 36)}:${process.pid}:${randomUUID()}`
const runNext = createMediaIngestWorker()
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'ingest', ...event })),
})

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

// The ingest worker already aborted inspect/probe/normalize/transcribe on a lost
// lease; what it never had was an outer signal to union with. Passing
// `shutdown.signal` is the whole fix — the FFmpeg child already watches it through
// `execFile({ signal })`.
const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: 'ingest', ...event })),
})

try {
  await runWithCleanup(
    async () => {
      while (!shutdown.stopping()) {
        try {
          const admission = await shutdown.admits()
          if (!admission.admits) {
            if (!shutdown.stopping()) await waitForPoll()
            continue
          }
          const outcome = await guard('media-ingest', runNext(workerId, shutdown.signal))
          if (outcome) console.info(JSON.stringify({ operationId: outcome.operationId, status: outcome.status }))
          else if (!shutdown.stopping()) await waitForPoll()
        } catch (error) {
          if (isShutdownDeadlineError(error)) throw error
          if (shutdown.stopping()) break
          console.error('Ingest worker iteration failed safely')
          await waitForPoll()
        }
      }
    },
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: 'ingest', ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
