import type {
  PrismaClient,
  V2WebhookDelivery,
  V2WebhookDeliveryAttempt,
} from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type {
  ClaimedWebhookDelivery,
  SettledWebhookDelivery,
  WebhookDeliveryFence,
  WebhookDeliveryRepository,
} from '../../application/ports/webhook-delivery-repository.ts'
import type {
  WebhookDeliveryDispatchTargetRepository,
} from '../../application/ports/webhook-delivery-dispatch.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import {
  createWebhookDelivery,
  createWebhookDeliveryAttempt,
  createWebhookSigningSecret,
  normalizeWebhookUrl,
  type WebhookDelivery,
  type WebhookDeliveryAttempt,
} from '../../domain/webhook.ts'

const CLAIM_SCAN_LIMIT = 32
const EXPIRED_LEASE_ERROR = 'lease_expired'

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

function hydrateAttempt(row: V2WebhookDeliveryAttempt): Readonly<WebhookDeliveryAttempt> {
  return createWebhookDeliveryAttempt({
    id: row.id,
    workspaceId: row.workspaceId,
    deliveryId: row.deliveryId,
    attemptNumber: row.attemptNumber,
    status: row.status as WebhookDeliveryAttempt['status'],
    scheduledAt: row.scheduledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.responseStatus !== null ? { responseStatus: row.responseStatus } : {}),
    ...(row.responseBodyHash ? { responseBodyHash: row.responseBodyHash } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  })
}

function leasedResult(
  delivery: V2WebhookDelivery,
  attempt: V2WebhookDeliveryAttempt,
  lease: { owner: string; attemptNumber: number; heartbeatAt: Date; expiresAt: Date },
): Readonly<ClaimedWebhookDelivery> {
  return Object.freeze({
    delivery: hydrateDelivery(delivery),
    attempt: hydrateAttempt(attempt),
    lease: Object.freeze({
      owner: lease.owner,
      attemptNumber: lease.attemptNumber,
      heartbeatAt: lease.heartbeatAt.toISOString(),
      expiresAt: lease.expiresAt.toISOString(),
    }),
  })
}

function settledResult(
  delivery: V2WebhookDelivery,
  attempt: V2WebhookDeliveryAttempt,
): Readonly<SettledWebhookDelivery> {
  return Object.freeze({
    delivery: hydrateDelivery(delivery),
    attempt: hydrateAttempt(attempt),
  })
}

function persistenceConflict(message: string): never {
  throw new DomainError('PERSISTENCE_CONFLICT', message)
}

export class PrismaWebhookDeliveryRepository
  implements WebhookDeliveryRepository, WebhookDeliveryDispatchTargetRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async claimNext(command: Parameters<WebhookDeliveryRepository['claimNext']>[0]) {
    const now = new Date(command.now)
    const leaseUntil = new Date(command.leaseUntil)
    return this.client.$transaction(async (transaction) => {
      const candidates = await transaction.v2WebhookDelivery.findMany({
        where: {
          workspaceId: command.workspaceId,
          subscription: {
            is: { status: 'active', endpoint: { is: { status: 'active' } } },
          },
          OR: [
            { status: 'pending', nextAttemptAt: { lte: now } },
            { status: 'retry-scheduled', nextAttemptAt: { lte: now } },
            { status: 'in-flight', leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: CLAIM_SCAN_LIMIT,
      })

      for (const candidate of candidates) {
        const expired = candidate.status === 'in-flight'
        if (expired && candidate.attemptCount >= candidate.maxAttempts) {
          const exhausted = await transaction.v2WebhookDelivery.updateMany({
            where: {
              id: candidate.id,
              workspaceId: command.workspaceId,
              status: 'in-flight',
              attemptCount: candidate.attemptCount,
              leaseExpiresAt: { lte: now },
              updatedAt: candidate.updatedAt,
            },
            data: {
              status: 'dead-lettered',
              completedAt: now,
              deadLetteredAt: now,
              leaseOwner: null,
              leaseTokenHash: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              updatedAt: now,
            },
          })
          if (exhausted.count === 0) continue
          const closed = await transaction.v2WebhookDeliveryAttempt.updateMany({
            where: {
              deliveryId: candidate.id,
              workspaceId: command.workspaceId,
              attemptNumber: candidate.attemptCount,
              status: 'in-flight',
            },
            data: { status: 'failed', completedAt: now, errorCode: EXPIRED_LEASE_ERROR },
          })
          if (closed.count !== 1) persistenceConflict('Expired webhook attempt could not be closed')
          continue
        }

        const attemptNumber = candidate.attemptCount + 1
        const claimed = await transaction.v2WebhookDelivery.updateMany({
          where: {
            id: candidate.id,
            workspaceId: command.workspaceId,
            status: candidate.status,
            attemptCount: candidate.attemptCount,
            updatedAt: candidate.updatedAt,
            ...(expired ? { leaseExpiresAt: { lte: now } } : { nextAttemptAt: { lte: now } }),
          },
          data: {
            status: 'in-flight',
            attemptCount: attemptNumber,
            leaseOwner: command.leaseOwner,
            leaseTokenHash: command.leaseTokenHash,
            leaseExpiresAt: leaseUntil,
            heartbeatAt: now,
            completedAt: null,
            deadLetteredAt: null,
            updatedAt: now,
          },
        })
        if (claimed.count === 0) continue

        if (expired) {
          const closed = await transaction.v2WebhookDeliveryAttempt.updateMany({
            where: {
              deliveryId: candidate.id,
              workspaceId: command.workspaceId,
              attemptNumber: candidate.attemptCount,
              status: 'in-flight',
            },
            data: { status: 'failed', completedAt: now, errorCode: EXPIRED_LEASE_ERROR },
          })
          if (closed.count !== 1) persistenceConflict('Expired webhook attempt could not be fenced')
        }

        const attempt = await transaction.v2WebhookDeliveryAttempt.create({
          data: {
            id: command.attemptId,
            workspaceId: command.workspaceId,
            deliveryId: candidate.id,
            attemptNumber,
            status: 'in-flight',
            scheduledAt: expired ? now : candidate.nextAttemptAt,
            startedAt: now,
            createdAt: now,
          },
        })
        const delivery = await transaction.v2WebhookDelivery.findUniqueOrThrow({
          where: { id: candidate.id },
        })
        return leasedResult(delivery, attempt, {
          owner: command.leaseOwner,
          attemptNumber,
          heartbeatAt: now,
          expiresAt: leaseUntil,
        })
      }
      return null
    })
  }

  async getDispatchTarget(
    fence: Parameters<WebhookDeliveryDispatchTargetRepository['getDispatchTarget']>[0],
  ) {
    const row = await this.client.v2WebhookDelivery.findFirst({
      where: this.activeFence(fence),
      select: {
        id: true,
        workspaceId: true,
        event: {
          select: {
            id: true,
            type: true,
            version: true,
            occurredAt: true,
            sequence: true,
            actorClientId: true,
            actorUserId: true,
            resourceType: true,
            resourceId: true,
            dataJson: true,
          },
        },
        subscription: {
          select: {
            status: true,
            endpoint: {
              select: {
                id: true,
                status: true,
                url: true,
                secrets: {
                  where: { status: 'active' },
                  orderBy: { version: 'desc' },
                  take: 2,
                  select: {
                    id: true,
                    workspaceId: true,
                    endpointId: true,
                    version: true,
                    keyRef: true,
                    fingerprint: true,
                    status: true,
                    createdAt: true,
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!row) return null
    const endpoint = row.subscription.endpoint
    if (row.subscription.status !== 'active' || endpoint.status !== 'active') {
      return Object.freeze({ status: 'blocked' as const, errorCode: 'target_inactive' as const })
    }
    if (endpoint.secrets.length !== 1) {
      return Object.freeze({
        status: 'blocked' as const,
        errorCode: 'signing_secret_unavailable' as const,
      })
    }
    const secret = createWebhookSigningSecret({
      ...endpoint.secrets[0],
      status: 'active',
      createdAt: endpoint.secrets[0].createdAt.toISOString(),
    })
    let data: unknown
    try {
      data = JSON.parse(row.event.dataJson)
    } catch {
      persistenceConflict('Webhook dispatch event contains invalid JSON')
    }
    let event
    try {
      event = createPublicEvent({
        id: row.event.id,
        workspaceId: row.workspaceId,
        type: row.event.type,
        version: row.event.version,
        occurredAt: row.event.occurredAt.toISOString(),
        ...(row.event.sequence !== null ? { sequence: row.event.sequence } : {}),
        ...(row.event.actorClientId || row.event.actorUserId
          ? {
              actor: {
                ...(row.event.actorClientId ? { clientId: row.event.actorClientId } : {}),
                ...(row.event.actorUserId ? { userId: row.event.actorUserId } : {}),
              },
            }
          : {}),
        resource: { type: row.event.resourceType, id: row.event.resourceId },
        data: data as Record<string, unknown>,
      })
    } catch {
      persistenceConflict('Webhook dispatch event is invalid')
    }
    return Object.freeze({
      status: 'ready' as const,
      target: Object.freeze({
        workspaceId: row.workspaceId,
        deliveryId: row.id,
        eventId: event.id,
        endpointId: endpoint.id,
        url: normalizeWebhookUrl(endpoint.url),
        secretKeyRef: secret.keyRef,
        secretVersion: secret.version,
        secretFingerprint: secret.fingerprint,
        rawBody: Buffer.from(stableSerialize(event), 'utf8'),
      }),
    })
  }

  async heartbeat(command: Parameters<WebhookDeliveryRepository['heartbeat']>[0]) {
    const now = new Date(command.now)
    const leaseUntil = new Date(command.leaseUntil)
    const updated = await this.client.v2WebhookDelivery.updateMany({
      where: this.activeFence(command),
      data: { heartbeatAt: now, leaseExpiresAt: leaseUntil, updatedAt: now },
    })
    return updated.count === 1
  }

  async succeed(command: Parameters<WebhookDeliveryRepository['succeed']>[0]) {
    return this.settle(command, {
      status: 'succeeded',
      responseStatus: command.responseStatus,
      ...(command.responseBodyHash ? { responseBodyHash: command.responseBodyHash } : {}),
    })
  }

  async failOrRetry(command: Parameters<WebhookDeliveryRepository['failOrRetry']>[0]) {
    return this.settle(command, {
      status: 'failed',
      ...(command.responseStatus !== undefined ? { responseStatus: command.responseStatus } : {}),
      ...(command.responseBodyHash ? { responseBodyHash: command.responseBodyHash } : {}),
      ...(command.errorCode ? { errorCode: command.errorCode } : {}),
      ...(command.nextAttemptAt ? { nextAttemptAt: command.nextAttemptAt } : {}),
    })
  }

  private activeFence(command: Readonly<WebhookDeliveryFence>) {
    return {
      id: command.deliveryId,
      workspaceId: command.workspaceId,
      status: 'in-flight',
      attemptCount: command.attemptNumber,
      leaseOwner: command.leaseOwner,
      leaseTokenHash: command.leaseTokenHash,
      leaseExpiresAt: { gt: new Date(command.now) },
    } as const
  }

  private async settle(
    command: Readonly<WebhookDeliveryFence>,
    outcome:
      | { status: 'succeeded'; responseStatus: number; responseBodyHash?: string }
      | {
          status: 'failed'
          responseStatus?: number
          responseBodyHash?: string
          errorCode?: string
          nextAttemptAt?: string
        },
  ) {
    const now = new Date(command.now)
    return this.client.$transaction(async (transaction) => {
      const current = await transaction.v2WebhookDelivery.findFirst({
        where: this.activeFence(command),
      })
      if (!current) return null

      const previousAttempt = await transaction.v2WebhookDeliveryAttempt.findUnique({
        where: {
          deliveryId_attemptNumber: {
            deliveryId: current.id,
            attemptNumber: command.attemptNumber,
          },
        },
      })
      if (!previousAttempt || previousAttempt.status !== 'in-flight' || !previousAttempt.startedAt) {
        persistenceConflict('Active webhook attempt is missing')
      }

      const attemptInput = {
        id: previousAttempt.id,
        workspaceId: previousAttempt.workspaceId,
        deliveryId: previousAttempt.deliveryId,
        attemptNumber: previousAttempt.attemptNumber,
        status: outcome.status,
        scheduledAt: previousAttempt.scheduledAt.toISOString(),
        createdAt: previousAttempt.createdAt.toISOString(),
        startedAt: previousAttempt.startedAt.toISOString(),
        completedAt: command.now,
        ...(outcome.responseStatus !== undefined ? { responseStatus: outcome.responseStatus } : {}),
        ...(outcome.responseBodyHash ? { responseBodyHash: outcome.responseBodyHash } : {}),
        ...(outcome.status === 'failed' && outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      } as const
      createWebhookDeliveryAttempt(attemptInput)

      const retryAt = outcome.status === 'failed' && outcome.nextAttemptAt
        ? new Date(outcome.nextAttemptAt)
        : null
      if (retryAt && (Number.isNaN(retryAt.getTime()) || retryAt <= now)) {
        throw new DomainError('INVALID_WEBHOOK', 'Webhook retry must be scheduled in the future')
      }
      const retry = Boolean(retryAt && current.attemptCount < current.maxAttempts)
      const deliveryStatus = outcome.status === 'succeeded'
        ? 'succeeded'
        : retry
          ? 'retry-scheduled'
          : 'dead-lettered'

      const updated = await transaction.v2WebhookDelivery.updateMany({
        where: this.activeFence(command),
        data: {
          status: deliveryStatus,
          ...(retryAt && retry ? { nextAttemptAt: retryAt } : {}),
          completedAt: retry ? null : now,
          deadLetteredAt: deliveryStatus === 'dead-lettered' ? now : null,
          leaseOwner: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: now,
        },
      })
      if (updated.count === 0) return null

      const attempt = await transaction.v2WebhookDeliveryAttempt.update({
        where: { id: previousAttempt.id },
        data: {
          status: outcome.status,
          completedAt: now,
          responseStatus: outcome.responseStatus ?? null,
          responseBodyHash: outcome.responseBodyHash ?? null,
          errorCode: outcome.status === 'failed' ? outcome.errorCode ?? null : null,
        },
      })
      const delivery = await transaction.v2WebhookDelivery.findUniqueOrThrow({
        where: { id: current.id },
      })
      return settledResult(delivery, attempt)
    })
  }
}
