import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedClient from '../src/v2/infrastructure/prisma-postgres/client.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'

const factory = importedFactory.createTemporalProducerWorker ? importedFactory : importedFactory.default
const client = importedClient.disconnectV2PostgresClient ? importedClient : importedClient.default
const lifecycle = importedLifecycle.createWorkerShutdown ? importedLifecycle : importedLifecycle.default
const opsState = importedOpsState.createFileAdmissionGate ? importedOpsState : importedOpsState.default
const { createTemporalProducerWorker } = factory
const { disconnectV2PostgresClient } = client
const { WORKER_SHUTDOWN_DEADLINE_EXIT_CODE, awaitWithShutdownDeadline, createWorkerShutdown,
  isShutdownDeadlineError, resolveWorkerShutdownGraceMs, runWithCleanup } = lifecycle
const { createFileAdmissionGate } = opsState

process.env.APOLLO_PROCESS_ROLE ??= 'temporal-producer-worker'
const pollMs = Number(process.env.APOLLO_V2_TEMPORAL_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
  throw new Error('APOLLO_V2_TEMPORAL_POLL_MS must be between 100 and 60000ms')
}
const graceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)
const host = hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 36) || 'unknown-host'
const owner = `temporal:${host}:${process.pid}:${randomUUID()}`
const runNext = createTemporalProducerWorker()
const shutdown = createWorkerShutdown({ process, gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'temporal-producer', ...event })) })

function waitForPoll() {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timeout); shutdown.signal.removeEventListener('abort', finish); resolve() }
    const timeout = setTimeout(finish, pollMs)
    shutdown.signal.addEventListener('abort', finish, { once: true })
  })
}
const guard = (work) => awaitWithShutdownDeadline(work, shutdown, { branch: 'temporal-producer',
  graceMs, onDeadline: (event) => console.error(JSON.stringify({ worker: 'temporal-producer', ...event })) })

try {
  await runWithCleanup(async () => {
    while (!shutdown.stopping()) {
      try {
        const admission = await shutdown.admits()
        if (!admission.admits) { if (!shutdown.stopping()) await waitForPoll(); continue }
        const outcome = await guard(runNext(owner, shutdown.signal))
        if (outcome) console.info(JSON.stringify({ worker: 'temporal-producer', ...outcome }))
        else if (!shutdown.stopping()) await waitForPoll()
      } catch (error) {
        if (isShutdownDeadlineError(error)) throw error
        if (!shutdown.stopping()) {
          console.error(JSON.stringify({ worker: 'temporal-producer', status: 'iteration-failed' }))
          await waitForPoll()
        }
      }
    }
  }, [
    { name: 'shutdown-listeners', run: () => shutdown.dispose() },
    { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
  ], (event) => console.error(JSON.stringify({ worker: 'temporal-producer', ...event,
    error: String(event.error) })))
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
