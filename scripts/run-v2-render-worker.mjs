import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

const repositoryFactory = importedRepositoryFactory.createProjectProxyRenderWorker
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const {
  createProjectProxyRenderWorker,
  createProjectFinalExportWorker,
  createSourceCleanupWorker,
  createProjectDirectorWorker,
  createPublicOperationWorker,
} = repositoryFactory
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

// Names this process's PostgreSQL backends before any factory builds a client, so
// `pg_stat_activity` can tell a render worker from the API server. Set with `??=`
// so a deployment that already declared a role keeps it.
process.env.APOLLO_PROCESS_ROLE ??= 'render-worker'

const pollIntervalMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('APOLLO_V2_WORKER_POLL_MS must be an integer of at least 100ms')
}
const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)

const workerId = `worker:${hostname().slice(0, 40)}:${process.pid}:${randomUUID()}`
const runNextProjectProxy = createProjectProxyRenderWorker()
const runNextProjectFinal = createProjectFinalExportWorker()
const runNextSourceCleanup = createSourceCleanupWorker()
const runNextProjectDirector = createProjectDirectorWorker()
const runNext = process.env.APOLLO_V2_RENDER_OUTPUT_ROOT?.trim()
  ? createPublicOperationWorker()
  : async () => null

const log = (event) => console.info(JSON.stringify({ worker: 'render', ...event }))
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log,
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

/**
 * The chain is five separate claims, not one.
 *
 * Until Wave 23 the loop checked a boolean once per iteration, at the top, so a
 * SIGTERM arriving while the proxy branch was inside FFmpeg was not observed until
 * every remaining branch had also been tried — and the branch after it could still
 * take a brand-new lease on the way out. Each branch now gets its own admission
 * check, and the signal goes into the branch itself so work already admitted is
 * told to stop rather than merely un-followed.
 */
const branches = [
  { name: 'project-director', run: (signal) => runNextProjectDirector(workerId, signal) },
  { name: 'project-final-export', run: (signal) => runNextProjectFinal(workerId, signal) },
  { name: 'project-proxy-render', run: (signal) => runNextProjectProxy(workerId, { signal }) },
  { name: 'source-cleanup', run: (signal) => runNextSourceCleanup(workerId, signal) },
  { name: 'artifact-render', run: (signal) => runNext(workerId, signal) },
]

// The director branch is why this exists: it has no port that takes a signal, so a
// stop cannot reach it at all once it is running. The deadline is the last resort
// after that — never instead of the graceful settle every other branch gets.
const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: 'render', ...event })),
})

try {
  await runWithCleanup(
    async () => {
      while (!shutdown.stopping()) {
        try {
          let outcome = null
          for (const branch of branches) {
            const admission = await shutdown.admits()
            if (!admission.admits) {
              outcome = null
              break
            }
            outcome = await guard(branch.name, branch.run(shutdown.signal))
            if (outcome) break
          }
          if (!outcome && !shutdown.stopping()) await waitForPoll()
        } catch (error) {
          if (isShutdownDeadlineError(error)) throw error
          if (shutdown.stopping()) break
          console.error('Render worker iteration failed safely')
          await waitForPoll()
        }
      }
    },
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: 'render', ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  // `process.exit`, not `process.exitCode`: the branch that overran is still holding
  // the event loop, which is exactly why the deadline fired. The cleanups above have
  // already run, so the connections are closed before this returns.
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
