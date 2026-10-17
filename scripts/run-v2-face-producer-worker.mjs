import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedClient from '../src/v2/infrastructure/prisma-postgres/client.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'
import * as importedErrors from '../src/v2/domain/errors.ts'

const factory = importedFactory.createFaceProducerWorker ? importedFactory : importedFactory.default
const client = importedClient.disconnectV2PostgresClient ? importedClient : importedClient.default
const lifecycle = importedLifecycle.createWorkerShutdown ? importedLifecycle : importedLifecycle.default
const opsState = importedOpsState.createFileAdmissionGate ? importedOpsState : importedOpsState.default
const errors = importedErrors.DomainError ? importedErrors : importedErrors.default
const { createFaceProducerWorker } = factory
const { disconnectV2PostgresClient } = client
const { WORKER_SHUTDOWN_DEADLINE_EXIT_CODE, awaitWithShutdownDeadline, createWorkerShutdown,
  isShutdownDeadlineError, resolveWorkerShutdownGraceMs, runWithCleanup } = lifecycle
const { createFileAdmissionGate } = opsState
const { DomainError } = errors

process.env.APOLLO_PROCESS_ROLE ??= 'face-producer-worker'
const pollMs = Number(process.env.APOLLO_V2_FACE_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
  throw new Error('APOLLO_V2_FACE_POLL_MS must be between 100 and 60000ms')
}
const graceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)
const host = hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 36) || 'unknown-host'
const owner = `face:${host}:${process.pid}:${randomUUID()}`
const runNext = createFaceProducerWorker()
const shutdown = createWorkerShutdown({ process, gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'face-producer', ...event })) })

function waitForPoll() {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timeout); shutdown.signal.removeEventListener('abort', finish); resolve() }
    const timeout = setTimeout(finish, pollMs)
    shutdown.signal.addEventListener('abort', finish, { once: true })
  })
}
const guard = (work) => awaitWithShutdownDeadline(work, shutdown, { branch: 'face-producer',
  graceMs, onDeadline: (event) => console.error(JSON.stringify({ worker: 'face-producer', ...event })) })
let lastIterationDiagnostic
const SAFE_CONFLICT_REASONS = new Map([
  ['Stored render color pipeline bindings are invalid', 'hydrate-render-color'],
  ['Stored proxy reuse Command impact is invalid', 'hydrate-proxy-impact'],
  ['Stored synthetic production render context is invalid', 'hydrate-synthetic-context'],
  ['Stored PublicOperation result is invalid', 'hydrate-result'],
  ['Stored long-form operation cost source is invalid', 'hydrate-longform-cost'],
  ['Stored PublicOperation actor audit is invalid', 'stored-actor-audit'],
  ['Stored PublicOperation context is invalid', 'stored-operation-context'],
  ['Stored render operation context is invalid', 'hydrate-render-context'],
  ['Stored synthetic render operation binding is invalid', 'hydrate-synthetic-binding'],
  ['Stored ingest operation context is invalid', 'hydrate-ingest-context'],
  ['Stored project proxy render context is invalid', 'hydrate-proxy-context'],
  ['Stored project final export context is invalid', 'hydrate-export-context'],
  ['Stored source cleanup operation context is invalid', 'hydrate-cleanup-context'],
  ['Stored long-form index operation context is invalid', 'hydrate-longform-context'],
  ['Stored project Director operation context is invalid', 'hydrate-director-context'],
  ['Stored perception producer operation context is invalid', 'hydrate-ocr-context'],
  ['Stored temporal producer operation context is invalid', 'hydrate-temporal-context'],
  ['Stored face producer operation context is invalid', 'stored-face-context'],
  ['Stored render checkpoint is invalid', 'hydrate-render-checkpoint'],
  ['Stored PublicOperation lease is invalid', 'stored-lease'],
  ['Stored PublicOperation progress is invalid', 'stored-progress'],
  ['Stored PublicOperation error is invalid', 'stored-error'],
  ['Stored PublicOperation retry schedule is invalid', 'stored-retry'],
  ['Stored PublicOperation failed integrity validation', 'stored-integrity'],
  ['Producer operation disappeared during transition', 'transition-missing'],
  ['Producer source artifact is unavailable', 'source-unavailable'],
  ['Producer source is not current and attached', 'source-not-current'],
  ['Producer operation source version is unavailable', 'version-unavailable'],
  ['Producer edit plan JSON is invalid', 'plan-json'],
  ['Producer edit plan timing is invalid', 'plan-timing'],
  ['Producer source does not cover the current timeline as one ordered source', 'plan-coverage'],
  ['Stored edit plan JSON is invalid', 'plan-stored-json'],
  ['Stored edit plan has no video tracks', 'plan-no-tracks'],
  ['Stored edit plan source-to-timeline range is invalid', 'plan-range'],
  ['Face producer requires exactly one source clip', 'plan-clip-count'],
])
function safeIterationDiagnostic(error) {
  if (error instanceof DomainError) {
    if (error.code === 'PERSISTENCE_CONFLICT') {
      return `${error.code}:${SAFE_CONFLICT_REASONS.get(error.message) ?? 'unclassified'}`
    }
    return error.code
  }
  if (error && typeof error === 'object' && typeof error.code === 'string' &&
      /^P\d{4}$/.test(error.code)) return error.code
  if (error && typeof error === 'object' && typeof error.name === 'string' &&
      /^PrismaClient(?:Validation|KnownRequest|UnknownRequest|Initialization|RustPanic)Error$/.test(error.name)) {
    return error.name
  }
  if (error instanceof TypeError) return 'TYPE_ERROR'
  if (error instanceof RangeError) return 'RANGE_ERROR'
  return 'UNKNOWN_ERROR'
}

try {
  await runWithCleanup(async () => {
    while (!shutdown.stopping()) {
      try {
        const admission = await shutdown.admits()
        if (!admission.admits) { if (!shutdown.stopping()) await waitForPoll(); continue }
        const outcome = await guard(runNext(owner, shutdown.signal))
        if (outcome) console.info(JSON.stringify({ worker: 'face-producer', ...outcome }))
        else if (!shutdown.stopping()) await waitForPoll()
      } catch (error) {
        if (isShutdownDeadlineError(error)) throw error
        if (!shutdown.stopping()) {
          const diagnostic = safeIterationDiagnostic(error)
          if (diagnostic !== lastIterationDiagnostic) {
            console.error(JSON.stringify({ worker: 'face-producer', status: 'iteration-failed',
              errorCode: diagnostic }))
            lastIterationDiagnostic = diagnostic
          }
          await waitForPoll()
        }
      }
    }
  }, [
    { name: 'shutdown-listeners', run: () => shutdown.dispose() },
    { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
  ], (event) => console.error(JSON.stringify({ worker: 'face-producer', ...event,
    error: String(event.error) })))
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
