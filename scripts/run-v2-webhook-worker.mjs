import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { runDiscoveredWebhookDeliveryWorkerLoop } from '../src/v2/application/run-webhook-delivery-worker.ts'
import {
  createConfiguredWebhookSigningSecretProvider,
  createWebhookDeliveryScheduler,
} from '../src/v2/infrastructure/repository-factory.ts'

function configuredInteger(name, defaultValue, minimum, maximum) {
  const value = Number(process.env[name] ?? defaultValue)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

const shardCount = configuredInteger('APOLLO_V2_WEBHOOK_SHARD_COUNT', 1, 1, 1_024)
const shardIndex = configuredInteger('APOLLO_V2_WEBHOOK_SHARD_INDEX', 0, 0, shardCount - 1)
const scanLimit = configuredInteger('APOLLO_V2_WEBHOOK_SCAN_LIMIT', 100, 1, 500)
const pollIntervalMs = configuredInteger('APOLLO_V2_WEBHOOK_POLL_MS', 1_000, 100, 60_000)
const host = hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 40) || 'unknown-host'
const leaseOwner = `webhook:${host}:${process.pid}:${randomUUID()}`
const secrets = createConfiguredWebhookSigningSecretProvider(process.env)
const scheduler = createWebhookDeliveryScheduler(secrets, process.env)
const controller = new AbortController()

process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

await runDiscoveredWebhookDeliveryWorkerLoop({
  discover: scheduler.discover,
  runNext: scheduler.runNext,
  shardIndex,
  shardCount,
  scanLimit,
  pollIntervalMs,
  leaseOwner,
  signal: controller.signal,
  onIterationError: () => console.error('Webhook worker iteration failed safely'),
  onDiscoveryError: () => console.error('Webhook worker discovery failed safely'),
})
