import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import * as importedWebhookWorker from '../src/v2/application/run-webhook-delivery-worker.ts'
import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'
import * as importedLifecycle from '../src/v2/application/worker-lifecycle.ts'
import * as importedOpsState from '../src/v2/infrastructure/ops-state/file-admission-gate.ts'
import * as importedPrismaClient from '../src/v2/infrastructure/prisma-postgres/client.ts'

const webhookWorker = importedWebhookWorker.runCoordinatedWebhookDeliveryWorkerLoop
  ? importedWebhookWorker
  : importedWebhookWorker.default
const {
  runCoordinatedWebhookDeliveryWorkerLoop,
  runDiscoveredWebhookDeliveryWorkerLoop,
} = webhookWorker
const repositoryFactory = importedRepositoryFactory.createWebhookDeliveryScheduler
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const {
  createConfiguredWebhookSigningSecretProvider,
  createWebhookDeliveryScheduler,
  createWebhookWorkerShardCoordinator,
} = repositoryFactory
const lifecycle = importedLifecycle.createWorkerShutdown
  ? importedLifecycle
  : importedLifecycle.default
const {
  WORKER_SHUTDOWN_DEADLINE_EXIT_CODE,
  awaitWithShutdownDeadline,
  createWorkerShutdown,
  isShutdownDeadlineError,
  resolveWorkerShutdownGraceMs,
  runWithCleanup,
} = lifecycle
const opsState = importedOpsState.createFileAdmissionGate
  ? importedOpsState
  : importedOpsState.default
const { createFileAdmissionGate } = opsState
const prismaClient = importedPrismaClient.disconnectV2PostgresClient
  ? importedPrismaClient
  : importedPrismaClient.default
const { disconnectV2PostgresClient } = prismaClient

process.env.APOLLO_PROCESS_ROLE ??= 'webhook-worker'

function configuredInteger(name, defaultValue, minimum, maximum) {
  const value = Number(process.env[name] ?? defaultValue)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

const shardCount = configuredInteger('APOLLO_V2_WEBHOOK_SHARD_COUNT', 1, 1, 1_024)
const scanLimit = configuredInteger('APOLLO_V2_WEBHOOK_SCAN_LIMIT', 100, 1, 500)
const pollIntervalMs = configuredInteger('APOLLO_V2_WEBHOOK_POLL_MS', 1_000, 100, 60_000)
const coordinationRetryMs = configuredInteger(
  'APOLLO_V2_WEBHOOK_SHARD_RETRY_MS',
  1_000,
  100,
  60_000,
)
const shardLeaseMs = configuredInteger(
  'APOLLO_V2_WEBHOOK_SHARD_LEASE_MS',
  30_000,
  5_000,
  5 * 60_000,
)
const shardHeartbeatMs = configuredInteger(
  'APOLLO_V2_WEBHOOK_SHARD_HEARTBEAT_MS',
  10_000,
  1_000,
  60_000,
)
if (shardHeartbeatMs >= shardLeaseMs) {
  throw new Error('APOLLO_V2_WEBHOOK_SHARD_HEARTBEAT_MS must be shorter than the shard lease')
}
const poolId = (process.env.APOLLO_V2_WEBHOOK_POOL_ID ?? 'webhook-delivery').trim()
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(poolId)) {
  throw new Error('APOLLO_V2_WEBHOOK_POOL_ID is invalid')
}
const shutdownGraceMs = resolveWorkerShutdownGraceMs(process.env.APOLLO_V2_WORKER_SHUTDOWN_GRACE_MS)
const host = hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 40) || 'unknown-host'
const leaseOwner = `webhook:${host}:${process.pid}:${randomUUID()}`
const secrets = createConfiguredWebhookSigningSecretProvider(process.env)
const scheduler = createWebhookDeliveryScheduler(secrets, process.env)
const coordinator = createWebhookWorkerShardCoordinator(process.env)
const shutdown = createWorkerShutdown({
  process,
  gate: createFileAdmissionGate(),
  log: (event) => console.info(JSON.stringify({ worker: 'webhook', ...event })),
})
const admits = async () => (await shutdown.admits()).admits

// The coordinated loop already releases its shard lease in its own `finally`; what
// this script never had was a Prisma disconnect, so every stop left a backend for
// the process teardown to reap — and a `docker stop` that times out never gets
// there.
// The delivery HTTP call is the one leaf in this worker that takes no signal, so an
// outbound request to a slow customer endpoint is exactly what this bounds.
const guard = (branch, work) => awaitWithShutdownDeadline(work, shutdown, {
  branch,
  graceMs: shutdownGraceMs,
  onDeadline: (event) => console.error(JSON.stringify({ worker: 'webhook', ...event })),
})

try {
  await runWithCleanup(
    () => guard('webhook-delivery', runCoordinatedWebhookDeliveryWorkerLoop({
    claimShard: () => coordinator.claim({ poolId, shardCount, leaseOwner }),
    heartbeatShard: (lease) => coordinator.heartbeat(lease),
    releaseShard: (lease) => coordinator.release(lease),
    signal: shutdown.signal,
    heartbeatIntervalMs: shardHeartbeatMs,
    retryIntervalMs: coordinationRetryMs,
    admits,
    onCoordinationError: () => console.error('Webhook worker coordination failed safely'),
    runAssignedShard: ({ shardIndex, shardCount: assignedShardCount, signal }) =>
      runDiscoveredWebhookDeliveryWorkerLoop({
        discover: scheduler.discover,
        runNext: scheduler.runNext,
        shardIndex,
        shardCount: assignedShardCount,
        scanLimit,
        pollIntervalMs,
        leaseOwner,
        signal,
        admits,
        onIterationError: () => console.error('Webhook worker iteration failed safely'),
        onDiscoveryError: () => console.error('Webhook worker discovery failed safely'),
      }),
    })),
    [
      { name: 'shutdown-listeners', run: () => shutdown.dispose() },
      { name: 'prisma-disconnect', run: () => disconnectV2PostgresClient() },
    ],
    (event) => console.error(JSON.stringify({ worker: 'webhook', ...event, error: String(event.error) })),
  )
} catch (error) {
  if (!isShutdownDeadlineError(error)) throw error
  process.exit(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE)
}
