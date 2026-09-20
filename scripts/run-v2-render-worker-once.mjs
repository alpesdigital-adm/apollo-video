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
  createProjectFinalExportWorker,
  createProjectProxyRenderWorker,
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

const kind = process.env.APOLLO_V2_WORKER_ONCE_KIND?.trim()
if (!['proxy', 'final'].includes(kind)) {
  throw new Error('APOLLO_V2_WORKER_ONCE_KIND must be proxy or final')
}

process.env.APOLLO_PROCESS_ROLE ??= `render-worker-once-${kind}`

const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)

const workerId = [
  'worker-once',
  kind,
  hostname().slice(0, 32),
  process.pid,
  randomUUID(),
].join(':')
const run = kind === 'proxy'
  ? createProjectProxyRenderWorker()
  : createProjectFinalExportWorker()

/**
 * One claim and exit — but the guarantees are the loop's, not the loop's alone.
 *
 * This entrypoint is spawned as a child by three E2E journeys, which means it is
 * on the receiving end of the same SIGTERM the harness sends when a journey times
 * out or is interrupted. Before Wave 23 it had no signal handler and no Prisma
 * disconnect at all, so an interrupted journey left a backend behind — the exact
 * shape of the 29 July 2026 orphan-connection incident.
 */
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: `render-once:${kind}`, ...event })),
})

const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: `render-once:${kind}`, ...event })),
})

let outcome
try {
  outcome = await runWithCleanup(
    async () => {
      const admission = await shutdown.admits()
      if (!admission.admits) return null
      return await guard(
        kind === 'proxy' ? 'project-proxy-render' : 'project-final-export',
        kind === 'proxy'
          ? run(workerId, { signal: shutdown.signal })
          : run(workerId, shutdown.signal),
      )
    },
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: `render-once:${kind}`, ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  // The journeys that spawn this read the outcome line, so it is written even here —
  // null, because the claim genuinely did not settle.
  process.stdout.write(`APOLLO_WORKER_OUTCOME=${JSON.stringify(null)}\n`)
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}

process.stdout.write(`APOLLO_WORKER_OUTCOME=${JSON.stringify(outcome)}\n`)
