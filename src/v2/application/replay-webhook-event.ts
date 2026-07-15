import { createHash, randomUUID } from 'node:crypto'

import type { WebhookEventReplayRepository } from './ports/webhook-event-replay-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function replayWebhookEventService(dependencies: {
  replays: WebhookEventReplayRepository
  clock?: () => Date
  createId?: () => string
  idempotencyTtlMs?: number
  maxDeliveries?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  const idempotencyTtlMs = dependencies.idempotencyTtlMs ?? 24 * 60 * 60 * 1_000
  const maxDeliveries = dependencies.maxDeliveries ?? 100
  assertDomain(
    Number.isSafeInteger(idempotencyTtlMs) &&
      idempotencyTtlMs >= 60_000 &&
      idempotencyTtlMs <= 7 * 24 * 60 * 60 * 1_000 &&
      Number.isSafeInteger(maxDeliveries) &&
      maxDeliveries >= 1 &&
      maxDeliveries <= 100,
    'INVALID_ARGUMENT',
    'Webhook event replay limits are invalid',
  )

  return async function replayWebhookEventCommand(request: {
    workspaceId: string
    clientId: string
    eventId: string
    idempotencyKey: string
  }) {
    const workspaceId = request.workspaceId.trim()
    const clientId = request.clientId.trim()
    const eventId = request.eventId.trim().toLowerCase()
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) &&
        SAFE_ID_PATTERN.test(clientId) &&
        UUID_V4_PATTERN.test(eventId),
      'INVALID_ARGUMENT',
      'Webhook event replay identity is invalid',
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
      'Webhook event replay clock is invalid',
    )
    const idempotencyId = createId().trim().toLowerCase()
    assertDomain(UUID_V4_PATTERN.test(idempotencyId), 'INVALID_ARGUMENT', 'Webhook event replay id is invalid')
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({
        action: 'webhook-event-replay/v1',
        workspaceId,
        clientId,
        eventId,
        maxDeliveries,
      }))
      .digest('hex')
    const result = await dependencies.replays.replayEvent({
      idempotencyId,
      workspaceId,
      clientId,
      idempotencyKey,
      requestFingerprint,
      eventId,
      requestedAt: requestedAt.toISOString(),
      nextAttemptAt: nextAttemptAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      maxDeliveries,
    })
    if (!result) throw new DomainError('WEBHOOK_EVENT_NOT_FOUND', 'Webhook event was not found')
    return result
  }
}
