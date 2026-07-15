import { createHash } from 'node:crypto'

import type {
  WebhookDeliveryListQuery,
  WebhookDeliveryQueryRepository,
} from './ports/webhook-delivery-query-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  WEBHOOK_DELIVERY_STATUSES,
  type WebhookDeliveryStatus,
} from '../domain/webhook.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface WebhookDeliveryCursor {
  v: 1
  createdAt: string
  id: string
  filterHash: string
}

function safeId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    SAFE_ID_PATTERN.test(normalized),
    'INVALID_ARGUMENT',
    `${field} must contain 3 to 128 safe characters`,
  )
  return normalized
}

function optionalUuid(value: string | undefined, field: string): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  assertDomain(UUID_V4_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field} must be a UUID v4`)
  return normalized
}

function createFilterHash(input: {
  workspaceId: string
  status?: WebhookDeliveryStatus
  endpointId?: string
  eventId?: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      workspaceId: input.workspaceId,
      status: input.status ?? null,
      endpointId: input.endpointId ?? null,
      eventId: input.eventId ?? null,
    }))
    .digest('hex')
}

function encodeCursor(cursor: WebhookDeliveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, expectedFilterHash: string): WebhookDeliveryCursor {
  assertDomain(CURSOR_PATTERN.test(value), 'INVALID_ARGUMENT', 'after is not a valid webhook delivery cursor')
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    assertDomain(
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
      'INVALID_ARGUMENT',
      'after is not a valid webhook delivery cursor',
    )
    const cursor = parsed as Record<string, unknown>
    assertDomain(
      Object.keys(cursor).length === 4 &&
        cursor.v === 1 &&
        typeof cursor.createdAt === 'string' &&
        new Date(cursor.createdAt).toISOString() === cursor.createdAt &&
        typeof cursor.id === 'string' &&
        UUID_V4_PATTERN.test(cursor.id) &&
        typeof cursor.filterHash === 'string' &&
        SHA256_PATTERN.test(cursor.filterHash) &&
        cursor.filterHash === expectedFilterHash,
      'INVALID_ARGUMENT',
      'after does not match this webhook delivery query',
    )
    return cursor as unknown as WebhookDeliveryCursor
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_ARGUMENT', 'after is not a valid webhook delivery cursor')
  }
}

export function listWebhookDeliveriesService(dependencies: {
  deliveries: WebhookDeliveryQueryRepository
}) {
  return async function listWebhookDeliveries(request: {
    workspaceId: string
    limit?: number
    after?: string
    status?: string
    endpointId?: string
    eventId?: string
  }) {
    const workspaceId = safeId(request.workspaceId, 'workspaceId')
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer from 1 to 100',
    )
    const statusValue = request.status?.trim()
    assertDomain(
      !statusValue || WEBHOOK_DELIVERY_STATUSES.includes(statusValue as WebhookDeliveryStatus),
      'INVALID_ARGUMENT',
      'status is not supported',
    )
    const status = statusValue as WebhookDeliveryStatus | undefined
    const endpointId = optionalUuid(request.endpointId, 'endpointId')
    const eventId = optionalUuid(request.eventId, 'eventId')
    const queryFilterHash = createFilterHash({ workspaceId, status, endpointId, eventId })
    const cursorValue = request.after?.trim()
    const after = cursorValue ? decodeCursor(cursorValue, queryFilterHash) : undefined
    const query: WebhookDeliveryListQuery = {
      workspaceId,
      limit: limit + 1,
      ...(status ? { status } : {}),
      ...(endpointId ? { endpointId } : {}),
      ...(eventId ? { eventId } : {}),
      ...(after ? { after: { createdAt: after.createdAt, id: after.id } } : {}),
    }
    const records = await dependencies.deliveries.list(query)
    assertDomain(
      records.length <= limit + 1,
      'PERSISTENCE_CONFLICT',
      'Webhook delivery query returned too many records',
    )
    const hasNextPage = records.length > limit
    const page = records.slice(0, limit)
    const last = page.at(-1)?.delivery
    return Object.freeze({
      deliveries: Object.freeze(page),
      ...(hasNextPage && last
        ? {
            nextCursor: encodeCursor({
              v: 1,
              createdAt: last.createdAt,
              id: last.id,
              filterHash: queryFilterHash,
            }),
          }
        : {}),
    })
  }
}
