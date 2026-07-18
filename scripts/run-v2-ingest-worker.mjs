import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import repositoryFactory from '../src/v2/infrastructure/repository-factory.ts'

const { createMediaIngestWorker } = repositoryFactory

const pollIntervalMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('APOLLO_V2_WORKER_POLL_MS must be an integer of at least 100ms')
}

const workerId = `ingest:${hostname().slice(0, 36)}:${process.pid}:${randomUUID()}`
const runNext = createMediaIngestWorker()
let stopping = false
process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })

while (!stopping) {
  try {
    const outcome = await runNext(workerId)
    if (outcome) console.info(JSON.stringify({ operationId: outcome.operationId, status: outcome.status }))
    else await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  } catch {
    console.error('Ingest worker iteration failed safely')
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}
