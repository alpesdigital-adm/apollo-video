import { Prisma, type PrismaClient } from '@prisma/client'

import type {
  WebhookSigningSecretHygieneRepository,
} from '../../application/ports/webhook-signing-secret-hygiene-repository.ts'
import { DomainError } from '../../domain/errors.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

export class PrismaWebhookSigningSecretHygieneRepository implements WebhookSigningSecretHygieneRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  async run(command: Parameters<WebhookSigningSecretHygieneRepository['run']>[0]) {
    const asOf = new Date(command.asOf)
    if (
      !SAFE_ID_PATTERN.test(command.workspaceId) || Number.isNaN(asOf.getTime()) ||
      !Number.isSafeInteger(command.limitPerKind) || command.limitPerKind < 1 || command.limitPerKind > 100
    ) throw new DomainError('INVALID_WEBHOOK', 'Webhook signing secret hygiene command is invalid')

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.$transaction(async (transaction) => {
        const rotations = await transaction.v2WebhookSigningSecretRotation.findMany({
          where: { workspaceId: command.workspaceId, status: 'staged', expiresAt: { lte: asOf } },
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          take: command.limitPerKind + 1,
          select: { id: true },
        })
        const rotationPage = rotations.slice(0, command.limitPerKind)
        const rotationIds = rotationPage.map((rotation) => rotation.id)
        const expiredRotations = rotationIds.length === 0 ? 0 : (await transaction.v2WebhookSigningSecretRotation.updateMany({
          where: {
            id: { in: rotationIds }, workspaceId: command.workspaceId,
            status: 'staged', expiresAt: { lte: asOf },
          },
          data: {
            status: 'expired', cancelledAt: asOf,
            payloadAlgorithm: null, payloadKeyId: null, payloadNonce: null,
            payloadCiphertext: null, payloadAuthTag: null,
          },
        })).count

        const secrets = await transaction.v2WebhookSigningSecret.findMany({
          where: {
            workspaceId: command.workspaceId,
            payload: { isNot: null },
            OR: [
              { status: 'retired', usableUntil: { lte: asOf } },
              { status: 'revoked' },
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: command.limitPerKind + 1,
          select: { id: true },
        })
        const secretIds = secrets.slice(0, command.limitPerKind).map((secret) => secret.id)
        const destroyedSigningSecretPayloads = secretIds.length === 0 ? 0 : (await transaction.v2WebhookSigningSecretPayload.deleteMany({
          where: { workspaceId: command.workspaceId, secretId: { in: secretIds } },
        })).count

        return Object.freeze({
          asOf: asOf.toISOString(),
          expiredRotations,
          destroyedRotationEnvelopes: expiredRotations,
          destroyedSigningSecretPayloads,
          hasMore: rotations.length > command.limitPerKind || secrets.length > command.limitPerKind,
        })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 3) continue
        if (isSerializationConflict(error)) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook signing secret hygiene conflicted with another transaction')
        }
        throw error
      }
    }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook signing secret hygiene could not complete')
  }
}
