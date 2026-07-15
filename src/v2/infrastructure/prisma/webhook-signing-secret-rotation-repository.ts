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
  ActivateWebhookSigningSecretRotationCommand,
  ActivateWebhookSigningSecretRotationResult,
  CancelWebhookSigningSecretRotationCommand,
  CancelWebhookSigningSecretRotationResult,
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
    ...(row.usableUntil ? { usableUntil: row.usableUntil.toISOString() } : {}),
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
    ...(row.overlapUntil ? { overlapUntil: row.overlapUntil.toISOString() } : {}),
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

function activationResult(
  endpointRow: V2WebhookEndpoint,
  rotationRow: V2WebhookSigningSecretRotation,
  previousSecretRow: V2WebhookSigningSecret,
  activatedSecretRow: V2WebhookSigningSecret,
  replayed: boolean,
): Readonly<ActivateWebhookSigningSecretRotationResult> {
  return Object.freeze({
    endpoint: endpoint(endpointRow),
    rotation: rotation(rotationRow),
    previousSecret: secret(previousSecretRow),
    activatedSecret: secret(activatedSecretRow),
    replayed,
  })
}

function cancellationResult(
  rotationRow: V2WebhookSigningSecretRotation,
  replayed: boolean,
): Readonly<CancelWebhookSigningSecretRotationResult> {
  return Object.freeze({ rotation: rotation(rotationRow), replayed })
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
      if (rotationRow.status !== 'staged') {
        throw new DomainError(
          'WEBHOOK_ENDPOINT_TRANSITION_REJECTED',
          'Idempotent webhook secret rotation staging result is no longer staged',
        )
      }
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
          data: {
            status: 'expired', cancelledAt: requestedAt,
            payloadAlgorithm: null, payloadKeyId: null, payloadNonce: null,
            payloadCiphertext: null, payloadAuthTag: null,
          },
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

  async activateOrReplay(command: Readonly<ActivateWebhookSigningSecretRotationCommand>) {
    const activatedAt = new Date(command.activatedAt)
    const readActivated = async (transaction: Prisma.TransactionClient | PrismaClient) => {
      const rotationRow = await transaction.v2WebhookSigningSecretRotation.findFirst({
        where: { id: command.rotationId, endpointId: command.endpointId, workspaceId: command.workspaceId },
      })
      if (!rotationRow || rotationRow.status !== 'activated') return null
      if (rotationRow.baseRevision !== command.baseRevision) {
        throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint revision does not match activated rotation')
      }
      const [endpointRow, previousSecretRow, activatedSecretRow] = await Promise.all([
        transaction.v2WebhookEndpoint.findFirst({ where: { id: command.endpointId, workspaceId: command.workspaceId } }),
        transaction.v2WebhookSigningSecret.findFirst({ where: { id: rotationRow.previousSecretId, endpointId: command.endpointId, workspaceId: command.workspaceId } }),
        transaction.v2WebhookSigningSecret.findFirst({ where: { id: rotationRow.candidateSecretId, endpointId: command.endpointId, workspaceId: command.workspaceId } }),
      ])
      if (!endpointRow || !previousSecretRow || !activatedSecretRow) throw new DomainError('PERSISTENCE_CONFLICT', 'Activated webhook secret rotation result is incomplete')
      return activationResult(endpointRow, rotationRow, previousSecretRow, activatedSecretRow, true)
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existingActivation = await readActivated(transaction)
        if (existingActivation) return existingActivation
        const [workspace, actor, endpointRow, rotationRow] = await Promise.all([
          transaction.v2Workspace.findUnique({ where: { id: command.workspaceId }, select: { status: true } }),
          transaction.v2ApiClient.findFirst({ where: { id: command.actorClientId, workspaceId: command.workspaceId, status: 'active' }, select: { id: true } }),
          transaction.v2WebhookEndpoint.findFirst({ where: { id: command.endpointId, workspaceId: command.workspaceId } }),
          transaction.v2WebhookSigningSecretRotation.findFirst({ where: { id: command.rotationId, endpointId: command.endpointId, workspaceId: command.workspaceId } }),
        ])
        if (!workspace || workspace.status !== 'active') throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')
        if (!endpointRow) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
        if (!rotationRow) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook signing secret rotation was not found')
        if (rotationRow.status !== 'staged') throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Webhook signing secret rotation cannot be activated')
        if (rotationRow.expiresAt <= activatedAt) throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Webhook signing secret rotation has expired')
        const currentEndpoint = endpoint(endpointRow)
        if (currentEndpoint.status !== 'active') throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Only an active webhook endpoint can activate a signing secret rotation')
        const currentRevision = webhookEndpointRevision(currentEndpoint)
        if (currentRevision !== command.baseRevision || rotationRow.baseRevision !== command.baseRevision) throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint revision does not match staged rotation')
        if (activatedAt < endpointRow.updatedAt) throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook signing secret rotation activation clock is stale')
        if (!rotationRow.payloadAlgorithm || !rotationRow.payloadKeyId || !rotationRow.payloadNonce || !rotationRow.payloadCiphertext || !rotationRow.payloadAuthTag) throw new DomainError('PERSISTENCE_CONFLICT', 'Staged webhook signing secret payload is incomplete')

        const [activeSecrets, latestSecret] = await Promise.all([
          transaction.v2WebhookSigningSecret.findMany({ where: { endpointId: command.endpointId, workspaceId: command.workspaceId, status: 'active' }, take: 2 }),
          transaction.v2WebhookSigningSecret.findFirst({ where: { endpointId: command.endpointId, workspaceId: command.workspaceId }, orderBy: { version: 'desc' } }),
        ])
        if (activeSecrets.length !== 1 || !latestSecret || activeSecrets[0].id !== rotationRow.previousSecretId || rotationRow.candidateVersion !== latestSecret.version + 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Staged webhook signing secret rotation no longer matches the active secret')
        const overlapUntil = new Date(activatedAt.getTime() + rotationRow.overlapSeconds * 1_000)
        const changed = await transaction.v2WebhookEndpoint.updateMany({
          where: { id: command.endpointId, workspaceId: command.workspaceId, status: 'active', updatedAt: endpointRow.updatedAt },
          data: { updatedAt: activatedAt },
        })
        if (changed.count !== 1) throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint changed concurrently')
        const retired = await transaction.v2WebhookSigningSecret.updateMany({
          where: { id: rotationRow.previousSecretId, workspaceId: command.workspaceId, endpointId: command.endpointId, status: 'active' },
          data: { status: 'retired', retiredAt: activatedAt, usableUntil: overlapUntil },
        })
        if (retired.count !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook signing secret changed concurrently')
        const activatedSecretRow = await transaction.v2WebhookSigningSecret.create({ data: {
          id: rotationRow.candidateSecretId, workspaceId: command.workspaceId, endpointId: command.endpointId,
          version: rotationRow.candidateVersion, algorithm: rotationRow.algorithm, keyRef: rotationRow.keyRef,
          fingerprint: rotationRow.fingerprint, status: 'active', createdAt: activatedAt,
        } })
        await transaction.v2WebhookSigningSecretPayload.create({ data: {
          secretId: rotationRow.candidateSecretId, workspaceId: command.workspaceId, endpointId: command.endpointId,
          secretVersion: rotationRow.candidateVersion, algorithm: rotationRow.payloadAlgorithm,
          keyId: rotationRow.payloadKeyId, nonce: rotationRow.payloadNonce,
          ciphertext: rotationRow.payloadCiphertext, authTag: rotationRow.payloadAuthTag, createdAt: activatedAt,
        } })
        const activatedRotationRow = await transaction.v2WebhookSigningSecretRotation.update({
          where: { id: rotationRow.id },
          data: {
            status: 'activated', activatedAt, overlapUntil,
            payloadAlgorithm: null, payloadKeyId: null, payloadNonce: null,
            payloadCiphertext: null, payloadAuthTag: null,
          },
        })
        const previousSecretRow = await transaction.v2WebhookSigningSecret.findUniqueOrThrow({ where: { id: rotationRow.previousSecretId } })
        const persistedEndpoint = await transaction.v2WebhookEndpoint.findUniqueOrThrow({ where: { id: command.endpointId } })
        return activationResult(persistedEndpoint, activatedRotationRow, previousSecretRow, activatedSecretRow, false)
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (isPrismaError(error, 'P2034') || isPrismaError(error, 'P2002')) {
        const replay = await readActivated(this.client)
        if (replay) return replay
        throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint or rotation changed concurrently')
      }
      throw error
    }
  }

  async cancelOrReplay(command: Readonly<CancelWebhookSigningSecretRotationCommand>) {
    const cancelledAt = new Date(command.cancelledAt)
    const readTerminal = async (transaction: Prisma.TransactionClient | PrismaClient) => {
      const row = await transaction.v2WebhookSigningSecretRotation.findFirst({
        where: { id: command.rotationId, endpointId: command.endpointId, workspaceId: command.workspaceId },
      })
      if (!row || (row.status !== 'cancelled' && row.status !== 'expired')) return null
      if (row.baseRevision !== command.baseRevision) {
        throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint revision does not match terminal rotation')
      }
      if (row.payloadAlgorithm || row.payloadKeyId || row.payloadNonce || row.payloadCiphertext || row.payloadAuthTag) {
        const scrubbed = await transaction.v2WebhookSigningSecretRotation.update({
          where: { id: row.id },
          data: {
            payloadAlgorithm: null, payloadKeyId: null, payloadNonce: null,
            payloadCiphertext: null, payloadAuthTag: null,
          },
        })
        return cancellationResult(scrubbed, true)
      }
      return cancellationResult(row, true)
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const [workspace, actor, endpointRow, rotationRow] = await Promise.all([
          transaction.v2Workspace.findUnique({ where: { id: command.workspaceId }, select: { status: true } }),
          transaction.v2ApiClient.findFirst({ where: { id: command.actorClientId, workspaceId: command.workspaceId, status: 'active' }, select: { id: true } }),
          transaction.v2WebhookEndpoint.findFirst({ where: { id: command.endpointId, workspaceId: command.workspaceId }, select: { id: true } }),
          transaction.v2WebhookSigningSecretRotation.findFirst({ where: { id: command.rotationId, endpointId: command.endpointId, workspaceId: command.workspaceId } }),
        ])
        if (!workspace || workspace.status !== 'active') throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')
        if (!endpointRow) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
        if (!rotationRow) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook signing secret rotation was not found')
        if (rotationRow.baseRevision !== command.baseRevision) throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint revision does not match staged rotation')
        if (rotationRow.status === 'activated') throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Activated webhook signing secret rotation cannot be cancelled')
        if (rotationRow.status === 'cancelled' || rotationRow.status === 'expired') {
          const terminal = await readTerminal(transaction)
          if (!terminal) throw new DomainError('PERSISTENCE_CONFLICT', 'Terminal webhook signing secret rotation is inconsistent')
          return terminal
        }
        if (rotationRow.status !== 'staged') throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Webhook signing secret rotation cannot be cancelled')
        if (cancelledAt < rotationRow.createdAt) throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook signing secret rotation cancellation clock is stale')
        const status = rotationRow.expiresAt <= cancelledAt ? 'expired' : 'cancelled'
        const changed = await transaction.v2WebhookSigningSecretRotation.updateMany({
          where: { id: rotationRow.id, status: 'staged' },
          data: {
            status, cancelledAt,
            payloadAlgorithm: null, payloadKeyId: null, payloadNonce: null,
            payloadCiphertext: null, payloadAuthTag: null,
          },
        })
        if (changed.count !== 1) {
          const terminal = await readTerminal(transaction)
          if (terminal) return terminal
          throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook signing secret rotation changed concurrently')
        }
        const persisted = await transaction.v2WebhookSigningSecretRotation.findUniqueOrThrow({ where: { id: rotationRow.id } })
        return cancellationResult(persisted, false)
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (isPrismaError(error, 'P2034')) {
        const terminal = await readTerminal(this.client)
        if (terminal) return terminal
        throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook signing secret rotation changed concurrently')
      }
      throw error
    }
  }
}
