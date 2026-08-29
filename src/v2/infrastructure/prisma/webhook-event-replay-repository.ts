import { Prisma, type PrismaClient, type V2IdempotencyRecord, type V2WebhookDelivery } from '../../../../generated/prisma-v2/index.js'

import type {
  WebhookEventReplayItem,
  WebhookEventReplayItemStatus,
  WebhookEventReplayRepository,
  WebhookEventReplayResult,
} from '../../application/ports/webhook-event-replay-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertWebhookAdministrationCommandTarget,
  assertWebhookAdministrationReplay,
  webhookAdministrationCommandData,
} from './webhook-administration-command-persistence.ts'
import {
  createWebhookDelivery,
  replayWebhookDelivery,
  type WebhookDelivery,
} from '../../domain/webhook.ts'
import { readCompletedIdempotencyResponse } from './idempotency-record-persistence.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ITEM_STATUSES: readonly WebhookEventReplayItemStatus[] = [
  'scheduled',
  'skipped-non-terminal',
  'skipped-target-inactive',
  'skipped-attempt-limit',
]

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

function persistenceConflict(message: string): never {
  throw new DomainError('PERSISTENCE_CONFLICT', message)
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

function parseStoredResult(
  parsed: Readonly<Record<string, unknown>>,
  workspaceId: string,
  eventId: string,
) {
  try {
    if (parsed.eventId !== eventId || !Array.isArray(parsed.items)) {
      persistenceConflict('Stored webhook event replay response is invalid')
    }
    const items = parsed.items.map((rawItem): Readonly<WebhookEventReplayItem> => {
      const item = rawItem as Record<string, unknown>
      const status = item.status as WebhookEventReplayItemStatus
      const rawSummary = item.delivery as Record<string, unknown>
      const rawDelivery = rawSummary.delivery as Record<string, unknown>
      const endpointId = rawSummary.endpointId
      const delivery = createWebhookDelivery({
        id: String(rawDelivery.id),
        workspaceId: String(rawDelivery.workspaceId),
        subscriptionId: String(rawDelivery.subscriptionId),
        eventId: String(rawDelivery.eventId),
        status: rawDelivery.status as WebhookDelivery['status'],
        attemptCount: Number(rawDelivery.attemptCount),
        maxAttempts: Number(rawDelivery.maxAttempts),
        nextAttemptAt: String(rawDelivery.nextAttemptAt),
        createdAt: String(rawDelivery.createdAt),
        ...(rawDelivery.completedAt ? { completedAt: String(rawDelivery.completedAt) } : {}),
        ...(rawDelivery.deadLetteredAt
          ? { deadLetteredAt: String(rawDelivery.deadLetteredAt) }
          : {}),
      })
      if (
        !ITEM_STATUSES.includes(status) ||
        delivery.workspaceId !== workspaceId ||
        delivery.eventId !== eventId ||
        typeof endpointId !== 'string' ||
        !UUID_V4_PATTERN.test(endpointId)
      ) {
        persistenceConflict('Stored webhook event replay item is invalid')
      }
      return Object.freeze({
        status,
        delivery: Object.freeze({ delivery, endpointId }),
      })
    })
    if (items.length > 100 || !items.some((item) => item.status === 'scheduled')) {
      persistenceConflict('Stored webhook event replay items are invalid')
    }
    return Object.freeze({ eventId, items: Object.freeze(items) })
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook event replay response is invalid')
  }
}

export class PrismaWebhookEventReplayRepository implements WebhookEventReplayRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async replayEvent(
    command: Parameters<WebhookEventReplayRepository['replayEvent']>[0],
    serializationAttempt = 1,
  ): Promise<Readonly<WebhookEventReplayResult> | null> {
    const administration = command.administration
    assertWebhookAdministrationCommandTarget(administration, {
      action: 'webhook-event.replay',
      targetType: 'webhook-event',
      targetId: command.eventId,
      workspaceId: command.workspaceId,
      requestFingerprint: command.requestFingerprint,
      idempotencyKey: command.idempotencyKey,
    })
    if (administration.audit.clientId !== command.clientId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook event replay audit actor does not match its mutation')
    }
    const requestedAt = new Date(command.requestedAt)
    const nextAttemptAt = new Date(command.nextAttemptAt)
    const expiresAt = new Date(command.expiresAt)
    if (
      !UUID_V4_PATTERN.test(command.idempotencyId) ||
      !SAFE_ID_PATTERN.test(command.workspaceId) ||
      !SAFE_ID_PATTERN.test(command.clientId) ||
      !UUID_V4_PATTERN.test(command.eventId) ||
      !SHA256_PATTERN.test(command.requestFingerprint) ||
      command.idempotencyKey.length < 1 ||
      command.idempotencyKey.length > 128 ||
      !Number.isSafeInteger(command.maxDeliveries) ||
      command.maxDeliveries < 1 ||
      command.maxDeliveries > 100 ||
      Number.isNaN(requestedAt.getTime()) ||
      Number.isNaN(nextAttemptAt.getTime()) ||
      Number.isNaN(expiresAt.getTime()) ||
      nextAttemptAt <= requestedAt ||
      expiresAt <= requestedAt
    ) {
      throw new DomainError('INVALID_WEBHOOK', 'Webhook event replay command is invalid')
    }

    const key = {
      workspaceId_clientId_key: {
        workspaceId: command.workspaceId,
        clientId: command.clientId,
        key: command.idempotencyKey,
      },
    }
    const readReplay = async (
      transaction: Prisma.TransactionClient | PrismaClient,
      record: V2IdempotencyRecord,
    ) => {
      const response = readCompletedIdempotencyResponse(
        record,
        command.requestFingerprint,
      )
      const auditCommand = await transaction.v2WebhookAdministrationCommand.findFirst({
        where: {
          workspaceId: command.workspaceId,
          targetType: 'webhook-event',
          targetId: command.eventId,
          action: 'webhook-event.replay',
          idempotencyKey: command.idempotencyKey,
          requestFingerprint: command.requestFingerprint,
        },
      })
      assertWebhookAdministrationReplay(auditCommand, administration)
      const stored = parseStoredResult(
        response,
        command.workspaceId,
        command.eventId,
      )
      return Object.freeze({ ...stored, replayed: true })
    }

    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > requestedAt) return await readReplay(transaction, existing)
        if (existing) await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })

        const event = await transaction.v2PublicEventOutbox.findFirst({
          where: { id: command.eventId, workspaceId: command.workspaceId },
          select: { id: true },
        })
        if (!event) return null
        const rows = await transaction.v2WebhookDelivery.findMany({
          where: { eventId: command.eventId, workspaceId: command.workspaceId },
          include: {
            subscription: {
              select: { status: true, endpointId: true, endpoint: { select: { status: true } } },
            },
          },
          orderBy: { id: 'asc' },
          take: command.maxDeliveries + 1,
        })
        if (rows.length > command.maxDeliveries) {
          throw new DomainError(
            'WEBHOOK_EVENT_REPLAY_LIMIT_EXCEEDED',
            'Webhook event has too many deliveries for one replay request',
          )
        }

        const planned = rows.map((row) => {
          const activeTarget =
            row.subscription.status === 'active' && row.subscription.endpoint.status === 'active'
          const terminal = row.status === 'succeeded' || row.status === 'dead-lettered'
          const status: WebhookEventReplayItemStatus = !activeTarget
            ? 'skipped-target-inactive'
            : !terminal
              ? 'skipped-non-terminal'
              : row.attemptCount >= 20
                ? 'skipped-attempt-limit'
                : 'scheduled'
          const delivery = status === 'scheduled'
            ? replayWebhookDelivery(
                hydrateDelivery(row),
                requestedAt.toISOString(),
                nextAttemptAt.toISOString(),
              )
            : hydrateDelivery(row)
          return {
            row,
            item: Object.freeze({
              status,
              delivery: Object.freeze({ delivery, endpointId: row.subscription.endpointId }),
            }),
          }
        })
        if (!planned.some(({ item }) => item.status === 'scheduled')) {
          throw new DomainError(
            'WEBHOOK_EVENT_REPLAY_REJECTED',
            'Webhook event has no eligible terminal deliveries to replay',
          )
        }

        await transaction.v2IdempotencyRecord.create({
          data: {
            id: command.idempotencyId,
            workspaceId: command.workspaceId,
            clientId: command.clientId,
            key: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
            status: 'processing',
            expiresAt,
          },
        })
        for (const { row, item } of planned) {
          if (item.status !== 'scheduled') continue
          const updated = await transaction.v2WebhookDelivery.updateMany({
            where: {
              id: row.id,
              workspaceId: command.workspaceId,
              status: row.status,
              updatedAt: row.updatedAt,
            },
            data: {
              status: item.delivery.delivery.status,
              maxAttempts: item.delivery.delivery.maxAttempts,
              nextAttemptAt,
              completedAt: null,
              deadLetteredAt: null,
              leaseOwner: null,
              leaseTokenHash: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              updatedAt: requestedAt,
            },
          })
          if (updated.count !== 1) persistenceConflict('Webhook event replay collided')
        }
        const items = Object.freeze(planned.map(({ item }) => item))
        const snapshot = Object.freeze({ eventId: command.eventId, items })
        await transaction.v2WebhookAdministrationCommand.create({
          data: webhookAdministrationCommandData(administration),
        })
        await transaction.v2IdempotencyRecord.update({
          where: { id: command.idempotencyId },
          data: {
            status: 'completed',
            responseStatus: 202,
            responseJson: JSON.stringify(snapshot),
          },
        })
        return Object.freeze({ ...snapshot, replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error)) {
        await new Promise<void>((resolve) => setTimeout(resolve, serializationAttempt * 10))
        const committed = await this.client.v2IdempotencyRecord.findUnique({ where: key })
        if (committed && committed.expiresAt > requestedAt && committed.status === 'completed') {
          return await readReplay(this.client, committed)
        }
        if (serializationAttempt < 3) {
          return this.replayEvent(command, serializationAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Webhook event replay conflicted with another transaction',
        )
      }
      if (isUniqueConstraintError(error)) {
        const existing = await this.client.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > requestedAt) return await readReplay(this.client, existing)
      }
      throw error
    }
  }
}
