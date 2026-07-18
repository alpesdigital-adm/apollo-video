import { randomUUID } from 'node:crypto'

import type {
  PrismaClient,
  V2PublicEventOutbox,
  V2WebhookDelivery,
} from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import type {
  MaterializeWebhookEventCommand,
  WebhookFanoutRepository,
} from '../../application/ports/webhook-fanout-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createPublicEvent, type PublicEvent } from '../../domain/public-event.ts'
import {
  createWebhookDelivery,
  createWebhookEventFilter,
  webhookEventMatchesFilter,
  type WebhookDelivery,
} from '../../domain/webhook.ts'

const MAX_ACTIVE_SUBSCRIPTIONS_PER_EVENT = 10_000

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function parseStringArray(value: string, field: string): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `${field} contains invalid JSON`)
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new DomainError('PERSISTENCE_CONFLICT', `${field} is not a string array`)
  }
  return parsed
}

function hydrateDelivery(row: V2WebhookDelivery): Readonly<WebhookDelivery> {
  return createWebhookDelivery({
    id: row.id,
    workspaceId: row.workspaceId,
    subscriptionId: row.subscriptionId,
    eventId: row.eventId,
    status: row.status as WebhookDelivery['status'],
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.deadLetteredAt ? { deadLetteredAt: row.deadLetteredAt.toISOString() } : {}),
  })
}

function hydrateEvent(row: V2PublicEventOutbox): Readonly<PublicEvent> {
  let data: unknown
  try {
    data = JSON.parse(row.dataJson)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook outbox event contains invalid JSON')
  }
  try {
    return createPublicEvent({
      id: row.id,
      workspaceId: row.workspaceId,
      type: row.type,
      version: row.version,
      occurredAt: row.occurredAt.toISOString(),
      ...(row.sequence !== null ? { sequence: row.sequence } : {}),
      ...(row.actorClientId || row.actorUserId
        ? {
            actor: {
              ...(row.actorClientId ? { clientId: row.actorClientId } : {}),
              ...(row.actorUserId ? { userId: row.actorUserId } : {}),
            },
          }
        : {}),
      resource: { type: row.resourceType, id: row.resourceId },
      data: data as Record<string, unknown>,
    })
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook outbox event is invalid')
  }
}

export class PrismaWebhookFanoutRepository implements WebhookFanoutRepository {
  private readonly client: PrismaClient
  private readonly createId: () => string

  constructor(client: PrismaClient = getV2PostgresClient(), createId: () => string = randomUUID) {
    this.client = client
    this.createId = createId
  }

  async materializeNext(command: Readonly<MaterializeWebhookEventCommand>) {
    const publishedAt = new Date(command.publishedAt)
    try {
      return await this.client.$transaction(async (transaction) => {
        const eventRow = await transaction.v2PublicEventOutbox.findFirst({
          where: { workspaceId: command.workspaceId, publishedAt: null },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        })
        if (!eventRow) return Object.freeze({ status: 'idle' as const })
        const event = hydrateEvent(eventRow)
        const occurredAt = new Date(event.occurredAt)
        if (publishedAt < occurredAt) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Webhook fan-out timestamp predates the event',
          )
        }

        const candidates = await transaction.v2WebhookSubscription.findMany({
          where: {
            workspaceId: event.workspaceId,
            status: 'active',
            createdAt: { lte: occurredAt },
            endpoint: {
              is: {
                status: 'active',
                verifiedAt: { lte: occurredAt },
              },
            },
          },
          orderBy: { id: 'asc' },
          take: MAX_ACTIVE_SUBSCRIPTIONS_PER_EVENT + 1,
          select: {
            id: true,
            workspaceId: true,
            filterEventTypesJson: true,
            filterResourceIdsJson: true,
            filterHash: true,
          },
        })
        if (candidates.length > MAX_ACTIVE_SUBSCRIPTIONS_PER_EVENT) {
          throw new DomainError(
            'WEBHOOK_FANOUT_LIMIT_EXCEEDED',
            'Webhook event exceeds the active subscription fan-out limit',
          )
        }

        const matching = candidates.filter((subscription) => {
          try {
            const filter = createWebhookEventFilter({
              eventTypes: parseStringArray(
                subscription.filterEventTypesJson,
                'Webhook event type filter',
              ),
              ...(subscription.filterResourceIdsJson !== null
                ? {
                    resourceIds: parseStringArray(
                      subscription.filterResourceIdsJson,
                      'Webhook resource filter',
                    ),
                  }
                : {}),
            })
            if (filter.hash !== subscription.filterHash) {
              throw new DomainError(
                'PERSISTENCE_CONFLICT',
                'Webhook subscription filter hash does not match its contents',
              )
            }
            return webhookEventMatchesFilter(filter, {
              type: event.type,
              resourceId: event.resource.id,
            })
          } catch (error) {
            if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') {
              throw error
            }
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Webhook subscription filter is invalid',
            )
          }
        })

        const deliveries: Readonly<WebhookDelivery>[] = []
        for (const subscription of matching) {
          const proposed = createWebhookDelivery({
            id: this.createId(),
            workspaceId: event.workspaceId,
            subscriptionId: subscription.id,
            eventId: event.id,
            status: 'pending',
            attemptCount: 0,
            maxAttempts: command.maxAttempts,
            nextAttemptAt: command.publishedAt,
            createdAt: command.publishedAt,
          })
          const row = await transaction.v2WebhookDelivery.upsert({
            where: {
              subscriptionId_eventId: {
                subscriptionId: subscription.id,
                eventId: event.id,
              },
            },
            update: {},
            create: {
              id: proposed.id,
              workspaceId: proposed.workspaceId,
              subscriptionId: proposed.subscriptionId,
              eventId: proposed.eventId,
              status: proposed.status,
              attemptCount: proposed.attemptCount,
              maxAttempts: proposed.maxAttempts,
              nextAttemptAt: new Date(proposed.nextAttemptAt),
              createdAt: new Date(proposed.createdAt),
            },
          })
          deliveries.push(hydrateDelivery(row))
        }

        await transaction.v2PublicEventOutbox.updateMany({
          where: { id: event.id, workspaceId: event.workspaceId, publishedAt: null },
          data: { publishedAt },
        })
        const routed = await transaction.v2PublicEventOutbox.findUniqueOrThrow({
          where: { id: event.id },
          select: { publishedAt: true },
        })
        if (!routed.publishedAt) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook event was not published')
        }
        return Object.freeze({
          status: 'published' as const,
          workspaceId: event.workspaceId,
          eventId: event.id,
          matchedSubscriptions: matching.length,
          deliveries: Object.freeze(deliveries),
          publishedAt: routed.publishedAt.toISOString(),
        })
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Webhook fan-out could not reserve a unique delivery identity',
        )
      }
      throw error
    }
  }
}
