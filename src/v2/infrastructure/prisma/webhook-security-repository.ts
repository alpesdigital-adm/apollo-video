import { timingSafeEqual } from 'node:crypto'

import type { PrismaClient, V2WebhookVerificationChallenge } from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type {
  VerifyWebhookChallengeCommand,
  WebhookChallengeRepository,
  WebhookChallengeTargetRepository,
  WebhookReplayReceiptRepository,
} from '../../application/ports/webhook-security-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createWebhookVerificationChallenge,
  type WebhookReplayReceipt,
  type WebhookVerificationChallenge,
  type WebhookChallengeStatus,
} from '../../domain/webhook-security.ts'

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function hydrateChallenge(row: V2WebhookVerificationChallenge): WebhookVerificationChallenge {
  return createWebhookVerificationChallenge({
    id: row.id,
    workspaceId: row.workspaceId,
    endpointId: row.endpointId,
    tokenHash: row.tokenHash,
    status: row.status as WebhookChallengeStatus,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt.toISOString() } : {}),
  })
}

function hashesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export class PrismaWebhookSecurityRepository
  implements
    WebhookChallengeRepository,
    WebhookChallengeTargetRepository,
    WebhookReplayReceiptRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async getPendingTarget(workspaceId: string, endpointId: string) {
    const endpoint = await this.client.v2WebhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId, status: 'pending-verification' },
      select: { workspaceId: true, id: true, url: true },
    })
    if (!endpoint) {
      throw new DomainError(
        'WEBHOOK_CHALLENGE_NOT_FOUND',
        'Pending webhook endpoint was not found',
      )
    }
    return Object.freeze({
      workspaceId: endpoint.workspaceId,
      endpointId: endpoint.id,
      url: endpoint.url,
    })
  }

  async issue(challenge: Readonly<WebhookVerificationChallenge>) {
    try {
      const row = await this.client.$transaction(async (transaction) => {
        const endpoint = await transaction.v2WebhookEndpoint.findFirst({
          where: {
            id: challenge.endpointId,
            workspaceId: challenge.workspaceId,
            status: 'pending-verification',
          },
          select: { id: true },
        })
        if (!endpoint) {
          throw new DomainError(
            'WEBHOOK_CHALLENGE_NOT_FOUND',
            'Pending webhook endpoint was not found',
          )
        }
        await transaction.v2WebhookVerificationChallenge.updateMany({
          where: {
            endpointId: challenge.endpointId,
            workspaceId: challenge.workspaceId,
            status: 'pending',
          },
          data: { status: 'expired', failedAt: new Date(challenge.createdAt) },
        })
        return transaction.v2WebhookVerificationChallenge.create({
          data: {
            id: challenge.id,
            workspaceId: challenge.workspaceId,
            endpointId: challenge.endpointId,
            tokenHash: challenge.tokenHash,
            status: challenge.status,
            attemptCount: challenge.attemptCount,
            maxAttempts: challenge.maxAttempts,
            expiresAt: new Date(challenge.expiresAt),
            createdAt: new Date(challenge.createdAt),
          },
        })
      })
      return hydrateChallenge(row)
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook challenge identity already exists')
      }
      throw error
    }
  }

  async verify(command: VerifyWebhookChallengeCommand) {
    const verifiedAt = new Date(command.verifiedAt)
    const outcome = await this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2WebhookVerificationChallenge.findFirst({
        where: {
          id: command.challengeId,
          endpointId: command.endpointId,
          workspaceId: command.workspaceId,
        },
      })
      if (!stored) return { kind: 'not-found' as const }
      if (stored.status !== 'pending') return { kind: 'rejected' as const }
      if (stored.expiresAt < verifiedAt) {
        await transaction.v2WebhookVerificationChallenge.updateMany({
          where: { id: stored.id, status: 'pending', attemptCount: stored.attemptCount },
          data: { status: 'expired', failedAt: verifiedAt },
        })
        return { kind: 'rejected' as const }
      }
      if (!hashesMatch(stored.tokenHash, command.responseHash)) {
        const nextAttempt = stored.attemptCount + 1
        await transaction.v2WebhookVerificationChallenge.updateMany({
          where: { id: stored.id, status: 'pending', attemptCount: stored.attemptCount },
          data: {
            attemptCount: nextAttempt,
            ...(nextAttempt >= stored.maxAttempts
              ? { status: 'failed', failedAt: verifiedAt }
              : {}),
          },
        })
        return { kind: 'rejected' as const }
      }

      const verified = await transaction.v2WebhookVerificationChallenge.updateMany({
        where: {
          id: stored.id,
          status: 'pending',
          tokenHash: command.responseHash,
          attemptCount: stored.attemptCount,
          expiresAt: { gte: verifiedAt },
        },
        data: { status: 'verified', verifiedAt },
      })
      if (verified.count !== 1) return { kind: 'rejected' as const }
      const endpoint = await transaction.v2WebhookEndpoint.updateMany({
        where: {
          id: command.endpointId,
          workspaceId: command.workspaceId,
          status: 'pending-verification',
        },
        data: { status: 'active', verifiedAt },
      })
      if (endpoint.count !== 1) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook endpoint state changed during challenge')
      }
      const subscriptions = await transaction.v2WebhookSubscription.updateMany({
        where: {
          endpointId: command.endpointId,
          workspaceId: command.workspaceId,
          status: 'pending-verification',
        },
        data: { status: 'active' },
      })
      const challenge = await transaction.v2WebhookVerificationChallenge.findUniqueOrThrow({
        where: { id: stored.id },
      })
      return {
        kind: 'verified' as const,
        challenge: hydrateChallenge(challenge),
        activatedSubscriptions: subscriptions.count,
      }
    })

    if (outcome.kind === 'not-found') {
      throw new DomainError('WEBHOOK_CHALLENGE_NOT_FOUND', 'Webhook challenge was not found')
    }
    if (outcome.kind === 'rejected') {
      throw new DomainError('WEBHOOK_CHALLENGE_REJECTED', 'Webhook challenge was rejected')
    }
    return {
      challenge: outcome.challenge,
      activatedSubscriptions: outcome.activatedSubscriptions,
    }
  }

  async consume(receipt: Readonly<WebhookReplayReceipt>) {
    try {
      await this.client.$transaction(async (transaction) => {
        const endpoint = await transaction.v2WebhookEndpoint.findFirst({
          where: {
            id: receipt.endpointId,
            workspaceId: receipt.workspaceId,
            status: 'active',
          },
          select: { id: true },
        })
        if (!endpoint) {
          throw new DomainError('WEBHOOK_CHALLENGE_NOT_FOUND', 'Active webhook endpoint was not found')
        }
        await transaction.v2WebhookReplayReceipt.deleteMany({
          where: {
            endpointId: receipt.endpointId,
            eventId: receipt.eventId,
            expiresAt: { lt: new Date(receipt.receivedAt) },
          },
        })
        await transaction.v2WebhookReplayReceipt.create({
          data: {
            id: receipt.id,
            workspaceId: receipt.workspaceId,
            endpointId: receipt.endpointId,
            eventId: receipt.eventId,
            signatureTimestamp: new Date(receipt.signatureTimestamp),
            receivedAt: new Date(receipt.receivedAt),
            expiresAt: new Date(receipt.expiresAt),
          },
        })
      })
      return receipt
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DomainError('WEBHOOK_REPLAY_DETECTED', 'Webhook event was already consumed')
      }
      throw error
    }
  }
}
