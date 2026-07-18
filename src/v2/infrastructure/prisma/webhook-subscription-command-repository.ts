import type { PrismaClient, V2WebhookSubscription } from '../../../../generated/prisma-v2/index.js'
import { Prisma } from '../../../../generated/prisma-v2/index.js'

import type {
  SetWebhookSubscriptionStatusCommand,
  SetWebhookSubscriptionStatusResult,
  WebhookSubscriptionCommandRepository,
} from '../../application/ports/webhook-subscription-command-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createWebhookSubscription,
  transitionWebhookSubscription,
  webhookSubscriptionRevision,
  type WebhookSubscription,
} from '../../domain/webhook.ts'

function parseStringArray(value: string | null, required: boolean): readonly string[] | undefined {
  if (value === null) {
    if (required) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook filter is invalid')
    return undefined
  }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook filter is invalid')
  }
}

function hydrate(row: V2WebhookSubscription): Readonly<WebhookSubscription> {
  const eventTypes = parseStringArray(row.filterEventTypesJson, true)!
  const resourceIds = parseStringArray(row.filterResourceIdsJson, false)
  try {
    return createWebhookSubscription({
      id: row.id,
      workspaceId: row.workspaceId,
      endpointId: row.endpointId,
      status: row.status as WebhookSubscription['status'],
      filter: { eventTypes, ...(resourceIds ? { resourceIds } : {}) },
      createdByClientId: row.createdByClientId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.pausedAt ? { pausedAt: row.pausedAt.toISOString() } : {}),
      ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    })
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook subscription is invalid')
  }
}

export class PrismaWebhookSubscriptionCommandRepository
  implements WebhookSubscriptionCommandRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async setStatus(
    command: Readonly<SetWebhookSubscriptionStatusCommand>,
    serializationAttempt = 1,
  ): Promise<Readonly<SetWebhookSubscriptionStatusResult> | null> {
    try {
      return await this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
        const row = await transaction.v2WebhookSubscription.findFirst({
          where: { id: command.subscriptionId, workspaceId: command.workspaceId },
        })
        if (!row) return null
        const current = hydrate(row)
        const currentRevision = webhookSubscriptionRevision(current)
        if (current.status === command.targetStatus) {
          return Object.freeze({
            subscription: current,
            revision: currentRevision,
            replayed: true,
          })
        }
        if (currentRevision !== command.baseRevision) {
          throw new DomainError(
            'WEBHOOK_SUBSCRIPTION_REVISION_MISMATCH',
            'Webhook subscription revision does not match',
          )
        }
        if (command.targetStatus === 'active') {
          const endpoint = await transaction.v2WebhookEndpoint.findFirst({
            where: { id: current.endpointId, workspaceId: current.workspaceId, status: 'active' },
            select: { id: true },
          })
          if (!endpoint) {
            throw new DomainError(
              'WEBHOOK_SUBSCRIPTION_TRANSITION_REJECTED',
              'Webhook subscription requires an active endpoint',
            )
          }
        }
        const next = transitionWebhookSubscription(current, command.targetStatus, command.changedAt)
        const changed = await transaction.v2WebhookSubscription.updateMany({
          where: {
            id: current.id,
            workspaceId: current.workspaceId,
            status: current.status,
            updatedAt: row.updatedAt,
          },
          data: {
            status: next.status,
            updatedAt: new Date(next.updatedAt),
            pausedAt: next.pausedAt ? new Date(next.pausedAt) : null,
            revokedAt: next.revokedAt ? new Date(next.revokedAt) : null,
          },
        })
        if (changed.count !== 1) {
          throw new DomainError(
            'WEBHOOK_SUBSCRIPTION_REVISION_MISMATCH',
            'Webhook subscription changed concurrently',
          )
        }
        return Object.freeze({
          subscription: next,
          revision: webhookSubscriptionRevision(next),
          replayed: false,
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034') {
        if (serializationAttempt < 3) {
          return this.setStatus(command, serializationAttempt + 1)
        }
        throw new DomainError(
          'WEBHOOK_SUBSCRIPTION_REVISION_MISMATCH',
          'Webhook subscription changed concurrently',
        )
      }
      throw error
    }
  }
}
