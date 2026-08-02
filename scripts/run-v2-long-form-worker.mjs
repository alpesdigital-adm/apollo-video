import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

const repositoryFactory =
  importedRepositoryFactory.createLongFormIndexWorker
    ? importedRepositoryFactory
    : importedRepositoryFactory.default
const { createLongFormIndexWorker } = repositoryFactory
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default
const { disconnectV2PostgresClient } = prismaClient

const pollIntervalMs = Number(
  process.env.APOLLO_V2_LONG_FORM_POLL_MS ??
    process.env.APOLLO_V2_WORKER_POLL_MS ??
    1_000,
)
if (
  !Number.isSafeInteger(pollIntervalMs) ||
  pollIntervalMs < 100 ||
  pollIntervalMs > 60_000
) {
  throw new Error(
    'APOLLO_V2_LONG_FORM_POLL_MS must be between 100 and 60000ms',
  )
}

const host = hostname()
  .replace(/[^A-Za-z0-9._:-]/g, '-')
  .slice(0, 36) || 'unknown-host'
const workerId =
  `long-form:${host}:${process.pid}:${randomUUID()}`
const controller = new AbortController()
const runNext = createLongFormIndexWorker()

process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

function waitForPoll() {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', finish)
      resolve()
    }
    const timeout = setTimeout(finish, pollIntervalMs)
    controller.signal.addEventListener('abort', finish, { once: true })
  })
}

try {
  while (!controller.signal.aborted) {
    try {
      const outcome = await runNext(workerId, controller.signal)
      if (outcome) {
        console.info(JSON.stringify({
          operationId: outcome.operationId,
          workflowId: outcome.workflowId,
          status: outcome.status,
        }))
      } else if (!controller.signal.aborted) {
        await waitForPoll()
      }
    } catch {
      if (!controller.signal.aborted) {
        console.error('Long-form worker iteration failed safely')
        await waitForPoll()
      }
    }
  }
} finally {
  await disconnectV2PostgresClient()
}
