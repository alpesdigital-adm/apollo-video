import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import * as importedFactory from '../src/v2/infrastructure/repository-factory.ts'

const factory = importedFactory.createLocalizationTranslationRuntime ? importedFactory : importedFactory.default
const once = process.argv.includes('--once'), pollMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1000)
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('APOLLO_V2_WORKER_POLL_MS must be between 100 and 60000')
const controller = new AbortController(), workerId = `localization-translation:${hostname().slice(0, 24)}:${process.pid}:${randomUUID()}`
process.once('SIGINT', () => controller.abort(new Error('SIGINT'))); process.once('SIGTERM', () => controller.abort(new Error('SIGTERM')))
const runtime = factory.createLocalizationTranslationRuntime()
const waitForPoll = () => new Promise((resolve, reject) => {
  if (controller.signal.aborted) { reject(controller.signal.reason); return }
  const timer = setTimeout(done, pollMs)
  function done() { controller.signal.removeEventListener('abort', aborted); resolve() }
  function aborted() { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); reject(controller.signal.reason) }
  controller.signal.addEventListener('abort', aborted, { once: true })
})
try {
  if (once) { const outcome = await runtime.runNext(workerId, controller.signal); process.stdout.write(`APOLLO_LOCALIZATION_TRANSLATION_OUTCOME=${JSON.stringify(outcome)}\n`); process.exitCode = outcome?.status === 'failed' ? 1 : 0 }
  else while (!controller.signal.aborted) { try { const outcome = await runtime.runNext(workerId, controller.signal); if (outcome) console.info(JSON.stringify({ runId: outcome.id, status: outcome.status })); else await waitForPoll() } catch (error) { if (controller.signal.aborted) break; console.error(error instanceof Error ? error.message : 'Localization translation worker iteration failed'); await waitForPoll() } }
} finally { await runtime.close() }
