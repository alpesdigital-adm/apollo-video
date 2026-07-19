import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'

const repositoryFactory = importedRepositoryFactory.createProjectProxyRenderWorker
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const { createProjectProxyRenderWorker, createProjectFinalExportWorker, createPublicOperationWorker } = repositoryFactory

const pollIntervalMs = Number(process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('APOLLO_V2_WORKER_POLL_MS must be an integer of at least 100ms')
}

const workerId = `worker:${hostname().slice(0, 40)}:${process.pid}:${randomUUID()}`
const runNextProjectProxy = createProjectProxyRenderWorker()
const runNextProjectFinal = createProjectFinalExportWorker()
const runNext = process.env.APOLLO_V2_RENDER_OUTPUT_ROOT?.trim()
  ? createPublicOperationWorker()
  : async () => null
let stopping = false

process.once('SIGINT', () => { stopping = true })
process.once('SIGTERM', () => { stopping = true })

while (!stopping) {
  try {
    const outcome = await runNextProjectFinal(workerId) ?? await runNextProjectProxy(workerId) ?? await runNext(workerId)
    if (!outcome) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  } catch {
    console.error('Render worker iteration failed safely')
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}
