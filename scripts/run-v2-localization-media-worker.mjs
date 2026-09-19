import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import * as importedFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

const factory = importedFactory.createLocalizationMediaRuntime ? importedFactory : importedFactory.default
const lifecycle = importedLifecycle.createWorkerShutdown ? importedLifecycle : importedLifecycle.default
const {
  WORKER_SHUTDOWN_DEADLINE_EXIT_CODE,
  awaitWithShutdownDeadline,
  createWorkerShutdown,
  isShutdownDeadlineError,
  resolveWorkerShutdownGraceMs,
  runWithCleanup,
} = lifecycle
const opsState = importedOpsState.createFileAdmissionGate ? importedOpsState : importedOpsState.default
const { createFileAdmissionGate } = opsState
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default
const { disconnectV2PostgresClient } = prismaClient

process.env.APOLLO_PROCESS_ROLE ??= 'localization-media-worker'

const once = process.argv.includes('--once')
const pollMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1000)
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('APOLLO_V2_WORKER_POLL_MS must be between 100 and 60000')
const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)
const workerId = `localization-media:${hostname().slice(0, 24)}:${process.pid}:${randomUUID()}`
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'localization-media', ...event })),
})
const runtime = factory.createLocalizationMediaRuntime()

function waitForPoll() {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      shutdown.signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, pollMs)
    shutdown.signal.addEventListener('abort', finish, { once: true })
  })
}

// This runtime can drive a nested proxy render, so the branch it admits reaches the
// same FFmpeg work the render worker does and needs the same last-resort bound.
const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: 'localization-media', ...event })),
})

try {
  await runWithCleanup(
    async () => {
      if (once) {
        const admission = await shutdown.admits()
        const outcome = admission.admits
          ? await guard('localization-media', runtime.runNext(workerId, shutdown.signal))
          : null
        process.stdout.write(`APOLLO_LOCALIZATION_MEDIA_OUTCOME=${JSON.stringify(outcome)}\n`)
        process.exitCode = outcome?.status === 'failed' || outcome?.status === 'blocked' ? 1 : 0
        return
      }
      while (!shutdown.stopping()) {
        const admission = await shutdown.admits()
        if (!admission.admits) {
          if (!shutdown.stopping()) await waitForPoll()
          continue
        }
        const outcome = await guard('localization-media', runtime.runNext(workerId, shutdown.signal))
        if (outcome) console.info(JSON.stringify({ runId: outcome.id, status: outcome.status }))
        else if (!shutdown.stopping()) await waitForPoll()
      }
    },
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'runtime-close', run: () => runtime.close() },
      { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: 'localization-media', ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
