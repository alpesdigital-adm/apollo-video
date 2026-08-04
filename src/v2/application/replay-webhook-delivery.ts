import { createHash, randomUUID } from 'node:crypto'

import type { WebhookDeliveryReplayRepository } from './ports/webhook-delivery-replay-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import { createWebhookAdministrationCommand } from '../domain/webhook-administration-command.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function replayWebhookDeliveryService(dependencies: {
  deliveries: WebhookDeliveryReplayRepository
  clock?: () => Date
  createId?: () => string
  idempotencyTtlMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  const idempotencyTtlMs = dependencies.idempotencyTtlMs ?? 24 * 60 * 60 * 1_000
  assertDomain(
    Number.isSafeInteger(idempotencyTtlMs) &&
      idempotencyTtlMs >= 60_000 &&
      idempotencyTtlMs <= 7 * 24 * 60 * 60 * 1_000,
    'INVALID_ARGUMENT',
    'Webhook replay idempotency TTL must be between one minute and seven days',
  )

  return async function replayWebhookDeliveryCommand(request: {
    workspaceId: string
    actor: AuthenticatedExternalActor
    deliveryId: string
    idempotencyKey: string
  }) {
    const workspaceId = request.workspaceId.trim()
    requireScope(request.actor, 'webhooks:admin')
    if (request.actor.workspaceId !== workspaceId) {
      throw new DomainError('WEBHOOK_DELIVERY_NOT_FOUND', 'Webhook delivery was not found')
    }
    const clientId = request.actor.clientId
    const deliveryId = request.deliveryId.trim().toLowerCase()
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) &&
        SAFE_ID_PATTERN.test(clientId) &&
        UUID_V4_PATTERN.test(deliveryId),
      'INVALID_ARGUMENT',
      'Webhook replay identity is invalid',
    )
    assertDomain(
      idempotencyKey.length >= 1 &&
        idempotencyKey.length <= 128 &&
        !/[\u0000-\u001f\u007f]/.test(idempotencyKey),
      'INVALID_ARGUMENT',
      'Idempotency-Key must contain 1 to 128 printable characters',
    )
    const requestedAt = clock()
    const nextAttemptAt = new Date(requestedAt.getTime() + 1)
    const expiresAt = new Date(requestedAt.getTime() + idempotencyTtlMs)
    assertDomain(
      !Number.isNaN(requestedAt.getTime()) &&
        !Number.isNaN(nextAttemptAt.getTime()) &&
        !Number.isNaN(expiresAt.getTime()),
      'INVALID_ARGUMENT',
      'Webhook replay clock is invalid',
    )
    const idempotencyId = createId().trim().toLowerCase()
    assertDomain(UUID_V4_PATTERN.test(idempotencyId), 'INVALID_ARGUMENT', 'Webhook replay id is invalid')
    const audit = materializeActorAuditContext(request.actor)
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({
        action: 'webhook-delivery-replay/v1',
        actorContextHash: audit.contextHash,
        workspaceId,
        clientId,
        deliveryId,
      }))
      .digest('hex')
    const result = await dependencies.deliveries.replay({
      administration: createWebhookAdministrationCommand({
        id: createId(),
        workspaceId,
        action: 'webhook-delivery.replay',
        targetType: 'webhook-delivery',
        targetId: deliveryId,
        audit,
        idempotencyKey,
        requestFingerprint,
        occurredAt: requestedAt.toISOString(),
      }),
      idempotencyId,
      workspaceId,
      clientId,
      idempotencyKey,
      requestFingerprint,
      deliveryId,
      requestedAt: requestedAt.toISOString(),
      nextAttemptAt: nextAttemptAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
    if (!result) {
      throw new DomainError('WEBHOOK_DELIVERY_NOT_FOUND', 'Webhook delivery was not found')
    }
    return result
  }
}
