import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedProviderJobs from '../src/v2/application/provider-jobs.ts'
import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

const providerJobs = importedProviderJobs.runProviderJobWorkerLoop
  ? importedProviderJobs
  : importedProviderJobs.default
const repositoryFactory = importedRepositoryFactory.createProviderJobWorker
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default

const pollIntervalMs = Number(process.env.APOLLO_V2_PROVIDER_POLL_MS ?? process.env.APOLLO_V2_WORKER_POLL_MS ?? 1_000)
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
  throw new Error('APOLLO_V2_PROVIDER_POLL_MS must be between 100 and 60000ms')
}

const host = hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 36) || 'unknown-host'
const workerId = `provider:${host}:${process.pid}:${randomUUID()}`
const controller = new AbortController()
const runNext = repositoryFactory.createProviderJobWorker(process.env)

process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

try {
  await providerJobs.runProviderJobWorkerLoop({
    workerId,
    runNext,
    signal: controller.signal,
    pollIntervalMs,
    onIterationError: () => console.error('Provider worker iteration failed safely'),
  })
} finally {
  await prismaClient.disconnectV2PostgresClient()
}
