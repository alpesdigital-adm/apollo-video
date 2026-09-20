import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import * as importedFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

const factory = importedFactory.createLocalizationTranslationRuntime ? importedFactory : importedFactory.default
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

process.env.APOLLO_PROCESS_ROLE ??= 'localization-translation-worker'

const once = process.argv.includes('--once'), pollMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1000)
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('APOLLO_V2_WORKER_POLL_MS must be between 100 and 60000')
const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)
const workerId = `localization-translation:${hostname().slice(0, 24)}:${process.pid}:${randomUUID()}`
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'localization-translation', ...event })),
})
const runtime = factory.createLocalizationTranslationRuntime()
// Rejects rather than resolves on abort, so an abort during the poll leaves the
// loop through the catch below instead of costing one more full poll interval.
const waitForPoll = () => new Promise((resolve, reject) => {
  if (shutdown.signal.aborted) { reject(shutdown.signal.reason); return }
  const timer = setTimeout(done, pollMs)
  function done() { shutdown.signal.removeEventListener('abort', aborted); resolve() }
  function aborted() { clearTimeout(timer); shutdown.signal.removeEventListener('abort', aborted); reject(shutdown.signal.reason) }
  shutdown.signal.addEventListener('abort', aborted, { once: true })
})

const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: 'localization-translation', ...event })),
})

try {
  await runWithCleanup(
    async () => {
      if (once) {
        const admission = await shutdown.admits()
        const outcome = admission.admits
          ? await guard('localization-translation', runtime.runNext(workerId, shutdown.signal))
          : null
        process.stdout.write(`APOLLO_LOCALIZATION_TRANSLATION_OUTCOME=${JSON.stringify(outcome)}\n`)
        process.exitCode = outcome?.status === 'failed' ? 1 : 0
        return
      }
      while (!shutdown.stopping()) {
        try {
          const admission = await shutdown.admits()
          if (!admission.admits) { await waitForPoll(); continue }
          const outcome = await guard('localization-translation', runtime.runNext(workerId, shutdown.signal))
          if (outcome) console.info(JSON.stringify({ runId: outcome.id, status: outcome.status }))
          else await waitForPoll()
        } catch (error) {
          if (isShutdownDeadlineError(error)) throw error
          if (shutdown.stopping()) break
          console.error(error instanceof Error ? error.message : 'Localization translation worker iteration failed')
          await waitForPoll()
        }
      }
    },
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'runtime-close', run: () => runtime.close() },
      { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: 'localization-translation', ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
