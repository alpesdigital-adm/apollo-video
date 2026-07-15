import type {
  Prisma,
  PrismaClient,
  V2IdempotencyRecord,
  V2WebhookEndpoint,
  V2WebhookSigningSecret,
  V2WebhookSigningSecretRotation,
} from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type {
  StageWebhookSigningSecretRotationCommand,
  StageWebhookSigningSecretRotationResult,
  WebhookSigningSecretRotationRepository,
} from '../../application/ports/webhook-signing-secret-rotation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createWebhookEndpoint, createWebhookSigningSecret, webhookEndpointRevision, type WebhookEndpoint, type WebhookSigningSecret } from '../../domain/webhook.ts'
import { createWebhookSigningSecretRotation, type WebhookSigningSecretRotation } from '../../domain/webhook-signing-secret-rotation.ts'

interface StoredRotationResponse { endpointId: string; rotationId: string }

function isPrismaError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function endpoint(row: V2WebhookEndpoint): Readonly<WebhookEndpoint> {
  return createWebhookEndpoint({
    id: row.id, workspaceId: row.workspaceId, url: row.url,
    status: row.status as WebhookEndpoint['status'], createdByClientId: row.createdByClientId,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
    ...(row.suspendedAt ? { suspendedAt: row.suspendedAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  })
}

function secret(row: V2WebhookSigningSecret): Readonly<WebhookSigningSecret> {
  return createWebhookSigningSecret({
    id: row.id, workspaceId: row.workspaceId, endpointId: row.endpointId, version: row.version,
    keyRef: row.keyRef, fingerprint: row.fingerprint, status: row.status as WebhookSigningSecret['status'],
    createdAt: row.createdAt.toISOString(),
    ...(row.retiredAt ? { retiredAt: row.retiredAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  })
}

function rotation(row: V2WebhookSigningSecretRotation): Readonly<WebhookSigningSecretRotation> {
  return createWebhookSigningSecretRotation({
    id: row.id, workspaceId: row.workspaceId, endpointId: row.endpointId,
    requestedByClientId: row.requestedByClientId, previousSecretId: row.previousSecretId,
    candidateSecretId: row.candidateSecretId, candidateVersion: row.candidateVersion,
    keyRef: row.keyRef, fingerprint: row.fingerprint,
    status: row.status as WebhookSigningSecretRotation['status'], overlapSeconds: row.overlapSeconds,
    baseRevision: row.baseRevision, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    ...(row.activatedAt ? { activatedAt: row.activatedAt.toISOString() } : {}),
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt.toISOString() } : {}),
  })
}

function storedResponse(record: V2IdempotencyRecord): StoredRotationResponse {
  if (record.status !== 'completed' || !record.responseJson) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent webhook secret rotation is incomplete')
  try {
    const parsed = JSON.parse(record.responseJson) as Partial<StoredRotationResponse>
    if (!parsed.endpointId || !parsed.rotationId) throw new Error('invalid')
    return { endpointId: parsed.endpointId, rotationId: parsed.rotationId }
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook secret rotation response is invalid')
  }
}

function result(endpointRow: V2WebhookEndpoint, rotationRow: V2WebhookSigningSecretRotation, replayed: boolean): Readonly<StageWebhookSigningSecretRotationResult> {
  return Object.freeze({ endpoint: endpoint(endpointRow), rotation: rotation(rotationRow), replayed })
}

export class PrismaWebhookSigningSecretRotationRepository implements WebhookSigningSecretRotationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async getTarget(workspaceId: string, endpointId: string) {
    const row = await this.client.v2WebhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId },
      include: { secrets: { orderBy: { version: 'desc' } } },
    })
    if (!row) return null
    const active = row.secrets.filter((item) => item.status === 'active')
    if (active.length !== 1 || !row.secrets[0]) throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint must have one active secret')
    return Object.freeze({ endpoint: endpoint(row), activeSecret: secret(active[0]), latestSecretVersion: row.secrets[0].version })
  }

  async stageOrReplay(command: Readonly<StageWebhookSigningSecretRotationCommand>) {
    const requestedAt = new Date(command.idempotency.requestedAt)
    const key = { workspaceId_clientId_key: { workspaceId: command.rotation.workspaceId, clientId: command.rotation.requestedByClientId, key: command.idempotency.key } }
    const readReplay = async (transaction: Prisma.TransactionClient | PrismaClient, record: V2IdempotencyRecord) => {
      if (record.requestFingerprint !== command.idempotency.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different request')
      const stored = storedResponse(record)
      const [endpointRow, rotationRow] = await Promise.all([
        transaction.v2WebhookEndpoint.findFirst({ where: { id: stored.endpointId, workspaceId: command.rotation.workspaceId } }),
        transaction.v2WebhookSigningSecretRotation.findFirst({ where: { id: stored.rotationId, workspaceId: command.rotation.workspaceId } }),
      ])
      if (!endpointRow || !rotationRow) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent webhook secret rotation result is missing')
      return result(endpointRow, rotationRow, true)
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > requestedAt) return readReplay(transaction, existing)
        if (existing) await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })
        const [workspace, actor, endpointRow] = await Promise.all([
          transaction.v2Workspace.findUnique({ where: { id: command.rotation.workspaceId }, select: { status: true } }),
          transaction.v2ApiClient.findFirst({ where: { id: command.rotation.requestedByClientId, workspaceId: command.rotation.workspaceId, status: 'active' }, select: { id: true } }),
          transaction.v2WebhookEndpoint.findFirst({ where: { id: command.rotation.endpointId, workspaceId: command.rotation.workspaceId } }),
        ])
        if (!workspace || workspace.status !== 'active') throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')
        if (!endpointRow) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
        const currentEndpoint = endpoint(endpointRow)
        if (currentEndpoint.status !== 'active') throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Only an active webhook endpoint can stage a signing secret rotation')
        if (webhookEndpointRevision(currentEndpoint) !== command.rotation.baseRevision) throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint revision does not match')

        await transaction.v2WebhookSigningSecretRotation.updateMany({
          where: { endpointId: command.rotation.endpointId, workspaceId: command.rotation.workspaceId, status: 'staged', expiresAt: { lte: requestedAt } },
          data: { status: 'expired', cancelledAt: requestedAt },
        })
        const [activeSecrets, latestSecret, staged] = await Promise.all([
          transaction.v2WebhookSigningSecret.findMany({ where: { endpointId: command.rotation.endpointId, workspaceId: command.rotation.workspaceId, status: 'active' }, take: 2 }),
          transaction.v2WebhookSigningSecret.findFirst({ where: { endpointId: command.rotation.endpointId, workspaceId: command.rotation.workspaceId }, orderBy: { version: 'desc' } }),
          transaction.v2WebhookSigningSecretRotation.findFirst({ where: { endpointId: command.rotation.endpointId, workspaceId: command.rotation.workspaceId, status: 'staged' } }),
        ])
        if (activeSecrets.length !== 1 || !latestSecret) throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint must have one active secret')
        if (staged) throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Webhook endpoint already has a staged signing secret rotation')
        if (command.rotation.previousSecretId !== activeSecrets[0].id || command.rotation.candidateVersion !== latestSecret.version + 1 || command.candidatePayload.secretId !== command.rotation.candidateSecretId || command.candidatePayload.secretVersion !== command.rotation.candidateVersion || command.candidatePayload.endpointId !== command.rotation.endpointId || command.candidatePayload.workspaceId !== command.rotation.workspaceId) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook signing secret rotation bundle is inconsistent')
        }
        await transaction.v2IdempotencyRecord.create({ data: { id: command.idempotency.id, workspaceId: command.rotation.workspaceId, clientId: command.rotation.requestedByClientId, key: command.idempotency.key, requestFingerprint: command.idempotency.requestFingerprint, status: 'processing', expiresAt: new Date(command.idempotency.expiresAt) } })
        const rotationRow = await transaction.v2WebhookSigningSecretRotation.create({ data: {
          id: command.rotation.id, workspaceId: command.rotation.workspaceId, endpointId: command.rotation.endpointId,
          requestedByClientId: command.rotation.requestedByClientId, previousSecretId: command.rotation.previousSecretId,
          candidateSecretId: command.rotation.candidateSecretId, candidateVersion: command.rotation.candidateVersion,
          algorithm: command.rotation.algorithm, keyRef: command.rotation.keyRef, fingerprint: command.rotation.fingerprint,
          status: command.rotation.status, overlapSeconds: command.rotation.overlapSeconds,
          payloadAlgorithm: command.candidatePayload.algorithm, payloadKeyId: command.candidatePayload.keyId,
          payloadNonce: command.candidatePayload.nonce, payloadCiphertext: command.candidatePayload.ciphertext,
          payloadAuthTag: command.candidatePayload.authTag, baseRevision: command.rotation.baseRevision,
          createdAt: new Date(command.rotation.createdAt), expiresAt: new Date(command.rotation.expiresAt),
        } })
        await transaction.v2IdempotencyRecord.update({ where: { id: command.idempotency.id }, data: { status: 'completed', responseStatus: 201, responseJson: JSON.stringify({ endpointId: command.rotation.endpointId, rotationId: rotationRow.id }) } })
        return result(endpointRow, rotationRow, false)
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (isPrismaError(error, 'P2034') || isPrismaError(error, 'P2002')) {
        const existing = await this.client.v2IdempotencyRecord.findUnique({ where: key })
        if (existing && existing.expiresAt > requestedAt) return readReplay(this.client, existing)
        throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint or rotation changed concurrently')
      }
      throw error
    }
  }
}
