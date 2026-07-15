import type {
  Prisma,
  PrismaClient,
  V2IdempotencyRecord,
  V2WebhookEndpoint,
  V2WebhookSigningSecret,
} from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type {
  WebhookSigningSecretProvisioningCommand,
  WebhookSigningSecretProvisioningRepository,
  WebhookSigningSecretProvisioningResult,
} from '../../application/ports/webhook-signing-secret-provisioning-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createWebhookEndpoint,
  createWebhookSigningSecret,
  webhookEndpointRevision,
  type WebhookEndpoint,
  type WebhookSigningSecret,
} from '../../domain/webhook.ts'

interface StoredProvisioningResponse {
  endpointId: string
  secretId: string
}

function isPrismaError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function storedResponse(record: V2IdempotencyRecord): StoredProvisioningResponse {
  if (record.status !== 'completed' || !record.responseJson) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent webhook secret provisioning is incomplete')
  }
  try {
    const value = JSON.parse(record.responseJson) as Partial<StoredProvisioningResponse>
    if (!value.endpointId || !value.secretId) throw new Error('invalid')
    return { endpointId: value.endpointId, secretId: value.secretId }
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook secret provisioning response is invalid')
  }
}

function endpoint(row: V2WebhookEndpoint): Readonly<WebhookEndpoint> {
  return createWebhookEndpoint({
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    status: row.status as WebhookEndpoint['status'],
    createdByClientId: row.createdByClientId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
    ...(row.suspendedAt ? { suspendedAt: row.suspendedAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  })
}

function secret(row: V2WebhookSigningSecret): Readonly<WebhookSigningSecret> {
  return createWebhookSigningSecret({
    id: row.id,
    workspaceId: row.workspaceId,
    endpointId: row.endpointId,
    version: row.version,
    keyRef: row.keyRef,
    fingerprint: row.fingerprint,
    status: row.status as WebhookSigningSecret['status'],
    createdAt: row.createdAt.toISOString(),
    ...(row.retiredAt ? { retiredAt: row.retiredAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  })
}

function result(
  endpointRow: V2WebhookEndpoint,
  secretRow: V2WebhookSigningSecret,
  replayed: boolean,
): Readonly<WebhookSigningSecretProvisioningResult> {
  return Object.freeze({
    endpoint: endpoint(endpointRow),
    secret: secret(secretRow),
    replayed,
  })
}

export class PrismaWebhookSigningSecretProvisioningRepository
  implements WebhookSigningSecretProvisioningRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async getTarget(workspaceId: string, endpointId: string) {
    const row = await this.client.v2WebhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId },
      include: {
        secrets: { orderBy: { version: 'desc' }, take: 1, select: { version: true } },
      },
    })
    if (!row) return null
    if (!row.secrets[0]) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint has no signing secret')
    }
    return Object.freeze({
      endpoint: endpoint(row),
      latestSecretVersion: row.secrets[0].version,
    })
  }

  async provisionOrReplay(command: Readonly<WebhookSigningSecretProvisioningCommand>) {
    const requestedAt = new Date(command.idempotency.requestedAt)
    const key = {
      workspaceId_clientId_key: {
        workspaceId: command.workspaceId,
        clientId: command.actorClientId,
        key: command.idempotency.key,
      },
    }

    const readReplay = async (
      transaction: Prisma.TransactionClient | PrismaClient,
      record: V2IdempotencyRecord,
    ) => {
      if (record.requestFingerprint !== command.idempotency.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was already used with a different request',
        )
      }
      const stored = storedResponse(record)
      const [endpointRow, secretRow] = await Promise.all([
        transaction.v2WebhookEndpoint.findFirst({
          where: { id: stored.endpointId, workspaceId: command.workspaceId },
        }),
        transaction.v2WebhookSigningSecret.findFirst({
          where: {
            id: stored.secretId,
            workspaceId: command.workspaceId,
            endpointId: stored.endpointId,
          },
        }),
      ])
      if (!endpointRow || !secretRow) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent webhook secret result is missing')
      }
      return result(endpointRow, secretRow, true)
    }

    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > requestedAt) {
          return readReplay(transaction, existing)
        }
        if (existing) await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })

        const [workspace, actor, endpointRow] = await Promise.all([
          transaction.v2Workspace.findUnique({
            where: { id: command.workspaceId },
            select: { status: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: command.actorClientId,
              workspaceId: command.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
          transaction.v2WebhookEndpoint.findFirst({
            where: { id: command.endpointId, workspaceId: command.workspaceId },
          }),
        ])
        if (!workspace || workspace.status !== 'active') {
          throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        }
        if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')
        if (!endpointRow) {
          throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
        }
        const currentEndpoint = endpoint(endpointRow)
        if (currentEndpoint.status !== 'pending-verification') {
          throw new DomainError(
            'WEBHOOK_ENDPOINT_TRANSITION_REJECTED',
            'Only a pending webhook endpoint can provision a one-time signing secret',
          )
        }
        if (webhookEndpointRevision(currentEndpoint) !== command.baseRevision) {
          throw new DomainError(
            'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
            'Webhook endpoint revision does not match',
          )
        }
        const [latestSecret, activeSecrets] = await Promise.all([
          transaction.v2WebhookSigningSecret.findFirst({
            where: { endpointId: command.endpointId, workspaceId: command.workspaceId },
            orderBy: { version: 'desc' },
          }),
          transaction.v2WebhookSigningSecret.findMany({
            where: {
              endpointId: command.endpointId,
              workspaceId: command.workspaceId,
              status: 'active',
            },
            take: 2,
          }),
        ])
        if (!latestSecret || activeSecrets.length !== 1) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint must have one active secret')
        }
        if (
          command.secret.workspaceId !== command.workspaceId ||
          command.secret.endpointId !== command.endpointId ||
          command.secret.version !== latestSecret.version + 1 ||
          command.secretPayload.workspaceId !== command.workspaceId ||
          command.secretPayload.endpointId !== command.endpointId ||
          command.secretPayload.secretId !== command.secret.id ||
          command.secretPayload.secretVersion !== command.secret.version
        ) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook signing secret bundle is inconsistent')
        }
        const changedAt = new Date(command.secret.createdAt)
        if (changedAt < endpointRow.updatedAt) {
          throw new DomainError(
            'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
            'Webhook secret provisioning clock is stale',
          )
        }

        await transaction.v2IdempotencyRecord.create({
          data: {
            id: command.idempotency.id,
            workspaceId: command.workspaceId,
            clientId: command.actorClientId,
            key: command.idempotency.key,
            requestFingerprint: command.idempotency.requestFingerprint,
            status: 'processing',
            expiresAt: new Date(command.idempotency.expiresAt),
          },
        })
        const changed = await transaction.v2WebhookEndpoint.updateMany({
          where: {
            id: command.endpointId,
            workspaceId: command.workspaceId,
            status: 'pending-verification',
            updatedAt: endpointRow.updatedAt,
          },
          data: { updatedAt: changedAt },
        })
        if (changed.count !== 1) {
          throw new DomainError(
            'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
            'Webhook endpoint changed concurrently',
          )
        }
        const retired = await transaction.v2WebhookSigningSecret.updateMany({
          where: { id: activeSecrets[0].id, status: 'active' },
          data: { status: 'retired', retiredAt: changedAt },
        })
        if (retired.count !== 1) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook signing secret changed concurrently')
        }
        const secretRow = await transaction.v2WebhookSigningSecret.create({
          data: {
            id: command.secret.id,
            workspaceId: command.secret.workspaceId,
            endpointId: command.secret.endpointId,
            version: command.secret.version,
            algorithm: command.secret.algorithm,
            keyRef: command.secret.keyRef,
            fingerprint: command.secret.fingerprint,
            status: command.secret.status,
            createdAt: changedAt,
          },
        })
        await transaction.v2WebhookSigningSecretPayload.create({
          data: {
            secretId: command.secretPayload.secretId,
            workspaceId: command.secretPayload.workspaceId,
            endpointId: command.secretPayload.endpointId,
            secretVersion: command.secretPayload.secretVersion,
            algorithm: command.secretPayload.algorithm,
            keyId: command.secretPayload.keyId,
            nonce: command.secretPayload.nonce,
            ciphertext: command.secretPayload.ciphertext,
            authTag: command.secretPayload.authTag,
            createdAt: changedAt,
          },
        })
        await transaction.v2IdempotencyRecord.update({
          where: { id: command.idempotency.id },
          data: {
            status: 'completed',
            responseStatus: 201,
            responseJson: JSON.stringify({
              endpointId: command.endpointId,
              secretId: secretRow.id,
            }),
          },
        })
        const persistedEndpoint = await transaction.v2WebhookEndpoint.findUniqueOrThrow({
          where: { id: command.endpointId },
        })
        return result(persistedEndpoint, secretRow, false)
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (isPrismaError(error, 'P2034')) {
        const existing = await this.client.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > requestedAt) return readReplay(this.client, existing)
        throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint changed concurrently')
      }
      if (isPrismaError(error, 'P2002')) {
        const existing = await this.client.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > requestedAt) return readReplay(this.client, existing)
        throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint changed concurrently')
      }
      throw error
    }
  }
}
