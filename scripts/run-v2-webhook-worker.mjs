import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import {
  runCoordinatedWebhookDeliveryWorkerLoop,
  runDiscoveredWebhookDeliveryWorkerLoop,
} from '../src/v2/application/run-webhook-delivery-worker.ts'
import * as importedRepositoryFactory from '../src/v2/infrastructure/repository-factory.ts'

const repositoryFactory = importedRepositoryFactory.createWebhookDeliveryScheduler
  ? importedRepositoryFactory
  : importedRepositoryFactory.default
const {
  createConfiguredWebhookSigningSecretProvider,
  createWebhookDeliveryScheduler,
  createWebhookWorkerShardCoordinator,
} = repositoryFactory

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
const host = hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 40) || 'unknown-host'
const leaseOwner = `webhook:${host}:${process.pid}:${randomUUID()}`
const secrets = createConfiguredWebhookSigningSecretProvider(process.env)
const scheduler = createWebhookDeliveryScheduler(secrets, process.env)
const coordinator = createWebhookWorkerShardCoordinator(process.env)
const controller = new AbortController()

process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

await runCoordinatedWebhookDeliveryWorkerLoop({
  claimShard: () => coordinator.claim({ poolId, shardCount, leaseOwner }),
  heartbeatShard: (lease) => coordinator.heartbeat(lease),
  releaseShard: (lease) => coordinator.release(lease),
  signal: controller.signal,
  heartbeatIntervalMs: shardHeartbeatMs,
  retryIntervalMs: coordinationRetryMs,
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
      onIterationError: () => console.error('Webhook worker iteration failed safely'),
      onDiscoveryError: () => console.error('Webhook worker discovery failed safely'),
    }),
})
