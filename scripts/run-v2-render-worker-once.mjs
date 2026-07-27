import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'

const repositoryFactory = importedRepositoryFactory.createProjectProxyRenderWorker
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const {
  createProjectFinalExportWorker,
  createProjectProxyRenderWorker,
} = repositoryFactory

const kind = process.env.APOLLO_V2_WORKER_ONCE_KIND?.trim()
if (!['proxy', 'final'].includes(kind)) {
  throw new Error('APOLLO_V2_WORKER_ONCE_KIND must be proxy or final')
}

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
const outcome = await run(workerId)

process.stdout.write(`APOLLO_WORKER_OUTCOME=${JSON.stringify(outcome)}\n`)
