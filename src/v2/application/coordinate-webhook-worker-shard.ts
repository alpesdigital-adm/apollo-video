import { randomUUID } from 'node:crypto'

import type { WebhookWorkerShardRepository } from './ports/webhook-worker-shard-repository.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  hashWebhookDeliveryLeaseToken,
  issueWebhookDeliveryLeaseToken,
} from '../domain/webhook-delivery-lease.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface WebhookWorkerShardLease {
  id: string
  poolId: string
  shardIndex: number
  shardCount: number
  leaseOwner: string
  leaseToken: string
  heartbeatAt: string
  leaseExpiresAt: string
  createdAt: string
}

function validateIdentity(input: { poolId: string; leaseOwner: string; shardCount: number }) {
  assertDomain(
    SAFE_ID_PATTERN.test(input.poolId) &&
      SAFE_ID_PATTERN.test(input.leaseOwner) &&
      Number.isSafeInteger(input.shardCount) &&
      input.shardCount >= 1 &&
      input.shardCount <= 1_024,
    'INVALID_WEBHOOK',
    'Webhook worker shard identity is invalid',
  )
}

export function coordinateWebhookWorkerShardService(dependencies: {
  repository: WebhookWorkerShardRepository
  clock?: () => Date
  createId?: () => string
  issueLease?: () => Readonly<{ token: string; tokenHash: string }>
  leaseDurationMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  const issueLease = dependencies.issueLease ?? (() => issueWebhookDeliveryLeaseToken())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  assertDomain(
    Number.isSafeInteger(leaseDurationMs) &&
      leaseDurationMs >= 5_000 &&
      leaseDurationMs <= 5 * 60_000,
    'INVALID_WEBHOOK',
    'Webhook worker shard lease duration is invalid',
  )

  return Object.freeze({
    async claim(request: { poolId: string; shardCount: number; leaseOwner: string }) {
      const poolId = request.poolId.trim()
      const leaseOwner = request.leaseOwner.trim()
      validateIdentity({ poolId, leaseOwner, shardCount: request.shardCount })
      const now = clock()
      const leaseUntil = new Date(now.getTime() + leaseDurationMs)
      assertDomain(
        !Number.isNaN(now.getTime()) && !Number.isNaN(leaseUntil.getTime()),
        'INVALID_WEBHOOK',
        'Webhook worker shard clock is invalid',
      )
      const id = createId().trim().toLowerCase()
      assertDomain(UUID_V4_PATTERN.test(id), 'INVALID_WEBHOOK', 'Webhook shard lease id is invalid')
      const lease = issueLease()
      const stored = await dependencies.repository.claim({
        id,
        poolId,
        shardCount: request.shardCount,
        leaseOwner,
        leaseTokenHash: lease.tokenHash,
        now: now.toISOString(),
        leaseUntil: leaseUntil.toISOString(),
      })
      if (!stored) return null
      assertDomain(
        stored.id === id &&
          stored.poolId === poolId &&
          stored.shardCount === request.shardCount &&
          stored.leaseOwner === leaseOwner &&
          stored.leaseTokenHash === lease.tokenHash &&
          stored.heartbeatAt === now.toISOString() &&
          stored.leaseExpiresAt === leaseUntil.toISOString() &&
          Number.isSafeInteger(stored.shardIndex) &&
          stored.shardIndex >= 0 &&
          stored.shardIndex < stored.shardCount,
        'PERSISTENCE_CONFLICT',
        'Webhook shard claim returned an invalid lease',
      )
      return Object.freeze({
        id: stored.id,
        poolId: stored.poolId,
        shardIndex: stored.shardIndex,
        shardCount: stored.shardCount,
        leaseOwner: stored.leaseOwner,
        leaseToken: lease.token,
        heartbeatAt: stored.heartbeatAt,
        leaseExpiresAt: stored.leaseExpiresAt,
        createdAt: stored.createdAt,
      })
    },

    async heartbeat(lease: Readonly<WebhookWorkerShardLease>) {
      validateLease(lease)
      const now = clock()
      const leaseUntil = new Date(now.getTime() + leaseDurationMs)
      assertDomain(
        !Number.isNaN(now.getTime()) && !Number.isNaN(leaseUntil.getTime()),
        'INVALID_WEBHOOK',
        'Webhook worker shard clock is invalid',
      )
      return dependencies.repository.heartbeat({
        ...fence(lease, now),
        leaseUntil: leaseUntil.toISOString(),
      })
    },

    async release(lease: Readonly<WebhookWorkerShardLease>) {
      validateLease(lease)
      const now = clock()
      assertDomain(!Number.isNaN(now.getTime()), 'INVALID_WEBHOOK', 'Webhook worker shard clock is invalid')
      return dependencies.repository.release(fence(lease, now))
    },
  })
}

function validateLease(lease: Readonly<WebhookWorkerShardLease>) {
  validateIdentity(lease)
  assertDomain(
    UUID_V4_PATTERN.test(lease.id) &&
      Number.isSafeInteger(lease.shardIndex) &&
      lease.shardIndex >= 0 &&
      lease.shardIndex < lease.shardCount,
    'INVALID_WEBHOOK',
    'Webhook worker shard lease is invalid',
  )
}

function fence(lease: Readonly<WebhookWorkerShardLease>, now: Date) {
  return {
    id: lease.id,
    poolId: lease.poolId,
    shardIndex: lease.shardIndex,
    shardCount: lease.shardCount,
    leaseOwner: lease.leaseOwner,
    leaseTokenHash: hashWebhookDeliveryLeaseToken(lease.leaseToken),
    now: now.toISOString(),
  }
}
