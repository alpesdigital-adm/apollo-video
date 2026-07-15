import type { PrismaClient, V2IdempotencyRecord, V2WebhookSubscription } from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type {
  WebhookSubscriptionCreationBundle,
  WebhookSubscriptionCreationRepository,
  WebhookSubscriptionCreationResult,
} from '../../application/ports/webhook-subscription-creation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createWebhookSubscription, type WebhookSubscription } from '../../domain/webhook.ts'

interface StoredWebhookSubscriptionCreationResponse {
  subscriptionId: string
}

function isPrismaError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parseStoredResponse(record: V2IdempotencyRecord): StoredWebhookSubscriptionCreationResponse {
  if (record.status !== 'completed' || !record.responseJson) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Idempotent webhook subscription creation is still processing or incomplete',
      { idempotencyRecordId: record.id, status: record.status },
    )
  }
  let response: Partial<StoredWebhookSubscriptionCreationResponse>
  try {
    response = JSON.parse(record.responseJson) as Partial<StoredWebhookSubscriptionCreationResponse>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored idempotency response is invalid', {
      idempotencyRecordId: record.id,
    })
  }
  if (!response.subscriptionId) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored idempotency response is invalid', {
      idempotencyRecordId: record.id,
    })
  }
  return { subscriptionId: response.subscriptionId }
}

function hydrate(row: V2WebhookSubscription): Readonly<WebhookSubscription> {
  try {
    const eventTypes = JSON.parse(row.filterEventTypesJson) as unknown
    const resourceIds = row.filterResourceIdsJson
      ? JSON.parse(row.filterResourceIdsJson) as unknown
      : undefined
    return createWebhookSubscription({
      id: row.id,
      workspaceId: row.workspaceId,
      endpointId: row.endpointId,
      status: row.status as WebhookSubscription['status'],
      filter: {
        eventTypes: eventTypes as string[],
        ...(resourceIds ? { resourceIds: resourceIds as string[] } : {}),
      },
      createdByClientId: row.createdByClientId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.pausedAt ? { pausedAt: row.pausedAt.toISOString() } : {}),
      ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    })
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook subscription is invalid', {
      subscriptionId: row.id,
    })
  }
}

export class PrismaWebhookSubscriptionCreationRepository
  implements WebhookSubscriptionCreationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async createOrReplay(
    bundle: Readonly<WebhookSubscriptionCreationBundle>,
  ): Promise<Readonly<WebhookSubscriptionCreationResult>> {
    const { subscription, idempotency } = bundle
    if (
      subscription.workspaceId !== idempotency.workspaceId ||
      subscription.createdByClientId !== idempotency.clientId
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook subscription creation bundle is inconsistent')
    }

    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_clientId_key: {
            workspaceId: idempotency.workspaceId,
            clientId: idempotency.clientId,
            key: idempotency.key,
          },
        }
        const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > new Date(idempotency.requestedAt)) {
          if (existing.requestFingerprint !== idempotency.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different request',
              { idempotencyRecordId: existing.id },
            )
          }
          const stored = parseStoredResponse(existing)
          const row = await transaction.v2WebhookSubscription.findFirst({
            where: { id: stored.subscriptionId, workspaceId: subscription.workspaceId },
          })
          if (!row) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency result is missing', {
              idempotencyRecordId: existing.id,
            })
          }
          return { subscription: hydrate(row), replayed: true }
        }
        if (existing) await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })

        const [workspace, endpoint, client] = await Promise.all([
          transaction.v2Workspace.findUnique({
            where: { id: subscription.workspaceId },
            select: { status: true },
          }),
          transaction.v2WebhookEndpoint.findFirst({
            where: { id: subscription.endpointId, workspaceId: subscription.workspaceId },
            select: { id: true, status: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: subscription.createdByClientId,
              workspaceId: subscription.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!workspace || workspace.status !== 'active') {
          throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        }
        if (!endpoint) {
          throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
        }
        if (!client) {
          throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')
        }
        if (endpoint.status !== 'active' && endpoint.status !== 'pending-verification') {
          throw new DomainError(
            'WEBHOOK_SUBSCRIPTION_CREATE_REJECTED',
            'Webhook subscription cannot be created for the endpoint in its current state',
            { endpointStatus: endpoint.status },
          )
        }
        const persisted = endpoint.status === 'pending-verification'
          ? createWebhookSubscription({
              ...subscription,
              status: 'pending-verification',
              filter: {
                eventTypes: subscription.filter.eventTypes,
                ...(subscription.filter.resourceIds
                  ? { resourceIds: subscription.filter.resourceIds }
                  : {}),
              },
            })
          : subscription

        await transaction.v2IdempotencyRecord.create({
          data: {
            id: idempotency.id,
            workspaceId: idempotency.workspaceId,
            clientId: idempotency.clientId,
            key: idempotency.key,
            requestFingerprint: idempotency.requestFingerprint,
            status: 'processing',
            expiresAt: new Date(idempotency.expiresAt),
          },
        })
        const row = await transaction.v2WebhookSubscription.create({
          data: {
            id: persisted.id,
            workspaceId: persisted.workspaceId,
            endpointId: persisted.endpointId,
            status: persisted.status,
            filterEventTypesJson: JSON.stringify(persisted.filter.eventTypes),
            filterResourceIdsJson: persisted.filter.resourceIds
              ? JSON.stringify(persisted.filter.resourceIds)
              : null,
            filterHash: persisted.filter.hash,
            createdByClientId: persisted.createdByClientId,
            createdAt: new Date(persisted.createdAt),
            updatedAt: new Date(persisted.updatedAt),
          },
        })
        await transaction.v2IdempotencyRecord.update({
          where: { id: idempotency.id },
          data: {
            status: 'completed',
            responseStatus: 201,
            responseJson: JSON.stringify({ subscriptionId: row.id }),
          },
        })
        return { subscription: hydrate(row), replayed: false }
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (isPrismaError(error, 'P2034')) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook subscription creation must be retried')
      }
      if (isPrismaError(error, 'P2002')) {
        const existing = await this.client.v2IdempotencyRecord.findUnique({
          where: {
            workspaceId_clientId_key: {
              workspaceId: idempotency.workspaceId,
              clientId: idempotency.clientId,
              key: idempotency.key,
            },
          },
        })
        if (existing) {
          if (existing.requestFingerprint !== idempotency.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different request',
            )
          }
          const stored = parseStoredResponse(existing)
          const row = await this.client.v2WebhookSubscription.findFirst({
            where: { id: stored.subscriptionId, workspaceId: subscription.workspaceId },
          })
          if (row) return { subscription: hydrate(row), replayed: true }
        }
        const duplicate = await this.client.v2WebhookSubscription.findFirst({
          where: { endpointId: subscription.endpointId, filterHash: subscription.filter.hash },
          select: { id: true },
        })
        if (duplicate) {
          throw new DomainError(
            'WEBHOOK_SUBSCRIPTION_ALREADY_EXISTS',
            'An identical webhook subscription already exists for this endpoint',
            { subscriptionId: duplicate.id },
          )
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook subscription identities could not be reserved')
      }
      throw error
    }
  }
}
