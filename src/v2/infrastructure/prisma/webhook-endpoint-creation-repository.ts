import type {
  PrismaClient,
  V2IdempotencyRecord,
  V2WebhookEndpoint,
  V2WebhookSigningSecret,
} from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type {
  WebhookEndpointCreationBundle,
  WebhookEndpointCreationRepository,
  WebhookEndpointCreationResult,
} from '../../application/ports/webhook-endpoint-creation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createWebhookEndpoint,
  createWebhookSigningSecret,
  type WebhookEndpoint,
  type WebhookSigningSecret,
} from '../../domain/webhook.ts'

interface StoredEndpointCreationResponse {
  endpointId: string
  secretId: string
}

function prismaError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function storedResponse(record: V2IdempotencyRecord): StoredEndpointCreationResponse {
  if (record.status !== 'completed' || !record.responseJson) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent webhook endpoint creation is incomplete')
  }
  try {
    const value = JSON.parse(record.responseJson) as Partial<StoredEndpointCreationResponse>
    if (!value.endpointId || !value.secretId) throw new Error('invalid')
    return { endpointId: value.endpointId, secretId: value.secretId }
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored endpoint creation response is invalid')
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
): Readonly<WebhookEndpointCreationResult> {
  return { endpoint: endpoint(endpointRow), secret: secret(secretRow), replayed }
}

export class PrismaWebhookEndpointCreationRepository implements WebhookEndpointCreationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async createOrReplay(
    bundle: Readonly<WebhookEndpointCreationBundle>,
    serializationAttempt = 1,
  ): Promise<Readonly<WebhookEndpointCreationResult>> {
    const { endpoint: candidate, secret: signingSecret, secretPayload, idempotency } = bundle
    if (
      candidate.workspaceId !== signingSecret.workspaceId ||
      candidate.workspaceId !== secretPayload.workspaceId ||
      candidate.workspaceId !== idempotency.workspaceId ||
      candidate.id !== signingSecret.endpointId ||
      candidate.id !== secretPayload.endpointId ||
      signingSecret.id !== secretPayload.secretId ||
      signingSecret.version !== secretPayload.secretVersion ||
      candidate.createdByClientId !== idempotency.clientId
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint creation bundle is inconsistent')
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
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different request')
          }
          const stored = storedResponse(existing)
          const [endpointRow, secretRow] = await Promise.all([
            transaction.v2WebhookEndpoint.findFirst({ where: { id: stored.endpointId, workspaceId: candidate.workspaceId } }),
            transaction.v2WebhookSigningSecret.findFirst({ where: { id: stored.secretId, workspaceId: candidate.workspaceId } }),
          ])
          if (!endpointRow || !secretRow) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent endpoint creation result is missing')
          }
          return result(endpointRow, secretRow, true)
        }
        if (existing) await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })

        const [workspace, client] = await Promise.all([
          transaction.v2Workspace.findUnique({ where: { id: candidate.workspaceId }, select: { status: true } }),
          transaction.v2ApiClient.findFirst({
            where: { id: candidate.createdByClientId, workspaceId: candidate.workspaceId, status: 'active' },
            select: { id: true },
          }),
        ])
        if (!workspace || workspace.status !== 'active') {
          throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        }
        if (!client) throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')

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
        const endpointRow = await transaction.v2WebhookEndpoint.create({
          data: {
            id: candidate.id,
            workspaceId: candidate.workspaceId,
            url: candidate.url,
            status: candidate.status,
            createdByClientId: candidate.createdByClientId,
            createdAt: new Date(candidate.createdAt),
            updatedAt: new Date(candidate.updatedAt),
          },
        })
        const secretRow = await transaction.v2WebhookSigningSecret.create({
          data: {
            id: signingSecret.id,
            workspaceId: signingSecret.workspaceId,
            endpointId: signingSecret.endpointId,
            version: signingSecret.version,
            algorithm: signingSecret.algorithm,
            keyRef: signingSecret.keyRef,
            fingerprint: signingSecret.fingerprint,
            status: signingSecret.status,
            createdAt: new Date(signingSecret.createdAt),
          },
        })
        await transaction.v2WebhookSigningSecretPayload.create({
          data: {
            secretId: secretPayload.secretId,
            workspaceId: secretPayload.workspaceId,
            endpointId: secretPayload.endpointId,
            secretVersion: secretPayload.secretVersion,
            algorithm: secretPayload.algorithm,
            keyId: secretPayload.keyId,
            nonce: secretPayload.nonce,
            ciphertext: secretPayload.ciphertext,
            authTag: secretPayload.authTag,
            createdAt: new Date(secretPayload.createdAt),
          },
        })
        await transaction.v2IdempotencyRecord.update({
          where: { id: idempotency.id },
          data: {
            status: 'completed',
            responseStatus: 201,
            responseJson: JSON.stringify({ endpointId: endpointRow.id, secretId: secretRow.id }),
          },
        })
        return result(endpointRow, secretRow, false)
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (prismaError(error, 'P2034')) {
        if (serializationAttempt < 3) {
          return this.createOrReplay(bundle, serializationAttempt + 1)
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint creation must be retried')
      }
      if (prismaError(error, 'P2002')) {
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
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different request')
          }
          const stored = storedResponse(existing)
          const [endpointRow, secretRow] = await Promise.all([
            this.client.v2WebhookEndpoint.findFirst({ where: { id: stored.endpointId, workspaceId: candidate.workspaceId } }),
            this.client.v2WebhookSigningSecret.findFirst({ where: { id: stored.secretId, workspaceId: candidate.workspaceId } }),
          ])
          if (endpointRow && secretRow) return result(endpointRow, secretRow, true)
        }
        const duplicate = await this.client.v2WebhookEndpoint.findFirst({
          where: { workspaceId: candidate.workspaceId, url: candidate.url },
          select: { id: true },
        })
        if (duplicate) {
          throw new DomainError('WEBHOOK_ENDPOINT_ALREADY_EXISTS', 'An endpoint with this exact URL already exists', { endpointId: duplicate.id })
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint identities could not be reserved')
      }
      throw error
    }
  }
}
