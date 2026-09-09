import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import * as importedFactory from '../src/v2/infrastructure/repository-factory.ts'

const factory = importedFactory.createLocalizationMediaRuntime ? importedFactory : importedFactory.default
const once = process.argv.includes('--once')
const pollMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1000)
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('APOLLO_V2_WORKER_POLL_MS must be between 100 and 60000')
const controller = new AbortController()
const workerId = `localization-media:${hostname().slice(0, 24)}:${process.pid}:${randomUUID()}`
process.once('SIGINT', () => controller.abort(new Error('SIGINT')))
process.once('SIGTERM', () => controller.abort(new Error('SIGTERM')))
const runtime = factory.createLocalizationMediaRuntime()
try {
  if (once) {
    const outcome = await runtime.runNext(workerId, controller.signal)
    process.stdout.write(`APOLLO_LOCALIZATION_MEDIA_OUTCOME=${JSON.stringify(outcome)}\n`)
    process.exitCode = outcome?.status === 'failed' || outcome?.status === 'blocked' ? 1 : 0
  } else while (!controller.signal.aborted) {
    const outcome = await runtime.runNext(workerId, controller.signal)
    if (outcome) console.info(JSON.stringify({ runId: outcome.id, status: outcome.status }))
    else await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs)
      controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
} finally {
  await runtime.close()
}
