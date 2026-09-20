import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'

const repositoryFactory =
  importedRepositoryFactory.createLongFormIndexWorker
    ? importedRepositoryFactory
    : importedRepositoryFactory.default
const { createLongFormIndexWorker } = repositoryFactory
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default
const { disconnectV2PostgresClient } = prismaClient
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

process.env.APOLLO_PROCESS_ROLE ??= 'long-form-worker'

const pollIntervalMs = Number(
  process.env.APOLLO_V2_LONG_FORM_POLL_MS ??
    process.env.APOLLO_V2_WORKER_POLL_MS ??
    1_000,
)
if (
  !Number.isSafeInteger(pollIntervalMs) ||
  pollIntervalMs < 100 ||
  pollIntervalMs > 60_000
) {
  throw new Error(
    'APOLLO_V2_LONG_FORM_POLL_MS must be between 100 and 60000ms',
  )
}

const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)

const host = hostname()
  .replace(/[^A-Za-z0-9._:-]/g, '-')
  .slice(0, 36) || 'unknown-host'
const workerId =
  `long-form:${host}:${process.pid}:${randomUUID()}`
const runNext = createLongFormIndexWorker()
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'long-form', ...event })),
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

const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: 'long-form', ...event })),
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
          const outcome = await guard('long-form-index', runNext(workerId, shutdown.signal))
          if (outcome) {
            console.info(JSON.stringify({
              operationId: outcome.operationId,
              workflowId: outcome.workflowId,
              status: outcome.status,
            }))
          } else if (!shutdown.stopping()) {
            await waitForPoll()
          }
        } catch (error) {
          if (isShutdownDeadlineError(error)) throw error
          if (!shutdown.stopping()) {
            console.error('Long-form worker iteration failed safely')
            await waitForPoll()
          }
        }
      }
    },
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: 'long-form', ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
