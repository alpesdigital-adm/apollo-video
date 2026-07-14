import { randomUUID } from 'node:crypto'

import type { WebhookDeliveryRepository } from './ports/webhook-delivery-repository.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  hashWebhookDeliveryLeaseToken,
  issueWebhookDeliveryLeaseToken,
} from '../domain/webhook-delivery-lease.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_LEASE_DURATION_MS = 300_000

function safeId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(SAFE_ID_PATTERN.test(normalized), 'INVALID_WEBHOOK', `${field} is invalid`)
  return normalized
}

function deliveryId(value: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(UUID_V4_PATTERN.test(normalized), 'INVALID_WEBHOOK', 'deliveryId must be a UUID v4')
  return normalized
}

function leaseDuration(value: number): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 1_000 && value <= MAX_LEASE_DURATION_MS,
    'INVALID_WEBHOOK',
    'Webhook lease duration must be between 1 and 300 seconds',
  )
  return value
}

function attemptNumber(value: number): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 1 && value <= 20,
    'INVALID_WEBHOOK',
    'Webhook attempt number is invalid',
  )
  return value
}

function canonicalNow(clock: () => Date): Date {
  const now = clock()
  assertDomain(!Number.isNaN(now.getTime()), 'INVALID_WEBHOOK', 'Webhook worker clock is invalid')
  return now
}

export function claimNextWebhookDeliveryService(dependencies: {
  repository: WebhookDeliveryRepository
  clock: () => Date
  createAttemptId?: () => string
  issueLease?: typeof issueWebhookDeliveryLeaseToken
  leaseDurationMs?: number
}) {
  const duration = leaseDuration(dependencies.leaseDurationMs ?? 30_000)
  return async function claimNextWebhookDelivery(request: {
    workspaceId: string
    leaseOwner: string
  }) {
    const now = canonicalNow(dependencies.clock)
    const issued = (dependencies.issueLease ?? issueWebhookDeliveryLeaseToken)()
    const claimed = await dependencies.repository.claimNext({
      workspaceId: safeId(request.workspaceId, 'workspaceId'),
      leaseOwner: safeId(request.leaseOwner, 'leaseOwner'),
      leaseTokenHash: issued.tokenHash,
      attemptId: (dependencies.createAttemptId ?? randomUUID)(),
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + duration).toISOString(),
    })
    return claimed ? Object.freeze({ ...claimed, leaseToken: issued.token }) : null
  }
}

export function heartbeatWebhookDeliveryService(dependencies: {
  repository: WebhookDeliveryRepository
  clock: () => Date
  leaseDurationMs?: number
}) {
  const duration = leaseDuration(dependencies.leaseDurationMs ?? 30_000)
  return async function heartbeatWebhookDelivery(request: {
    workspaceId: string
    deliveryId: string
    leaseOwner: string
    leaseToken: string
    attemptNumber: number
  }) {
    const now = canonicalNow(dependencies.clock)
    return dependencies.repository.heartbeat({
      workspaceId: safeId(request.workspaceId, 'workspaceId'),
      deliveryId: deliveryId(request.deliveryId),
      leaseOwner: safeId(request.leaseOwner, 'leaseOwner'),
      leaseTokenHash: hashWebhookDeliveryLeaseToken(request.leaseToken),
      attemptNumber: attemptNumber(request.attemptNumber),
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + duration).toISOString(),
    })
  }
}

export function settleWebhookDeliveryService(dependencies: {
  repository: WebhookDeliveryRepository
  clock: () => Date
}) {
  return async function settleWebhookDelivery(request: {
    workspaceId: string
    deliveryId: string
    leaseOwner: string
    leaseToken: string
    attemptNumber: number
    outcome:
      | { status: 'succeeded'; responseStatus: number; responseBodyHash?: string }
      | {
          status: 'failed'
          responseStatus?: number
          responseBodyHash?: string
          errorCode?: string
          nextAttemptAt?: string
        }
  }) {
    const now = canonicalNow(dependencies.clock).toISOString()
    const fence = {
      workspaceId: safeId(request.workspaceId, 'workspaceId'),
      deliveryId: deliveryId(request.deliveryId),
      leaseOwner: safeId(request.leaseOwner, 'leaseOwner'),
      leaseTokenHash: hashWebhookDeliveryLeaseToken(request.leaseToken),
      attemptNumber: attemptNumber(request.attemptNumber),
      now,
    }
    return request.outcome.status === 'succeeded'
      ? dependencies.repository.succeed({ ...fence, ...request.outcome })
      : dependencies.repository.failOrRetry({ ...fence, ...request.outcome })
  }
}
