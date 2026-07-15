import type { PrismaClient, V2WebhookEndpoint } from '@prisma/client'
import { Prisma } from '@prisma/client'

import type {
  SetWebhookEndpointStatusCommand,
  WebhookEndpointCommandRepository,
} from '../../application/ports/webhook-endpoint-command-repository.ts'
import type {
  WebhookEndpointSummaryRecord,
  WebhookSigningSecretMetadata,
} from '../../application/ports/webhook-administration-query-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createWebhookEndpoint,
  transitionWebhookEndpoint,
  webhookEndpointRevision,
  type WebhookEndpoint,
} from '../../domain/webhook.ts'

function hydrateEndpoint(row: V2WebhookEndpoint): Readonly<WebhookEndpoint> {
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

function hydrateSecret(value: {
  version: number
  fingerprint: string
  status: string
  createdAt: Date
  retiredAt: Date | null
  revokedAt: Date | null
}): Readonly<WebhookSigningSecretMetadata> {
  if (!['active', 'retired', 'revoked'].includes(value.status)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored webhook secret metadata is invalid')
  }
  return Object.freeze({
    version: value.version,
    fingerprint: value.fingerprint,
    status: value.status as WebhookSigningSecretMetadata['status'],
    createdAt: value.createdAt.toISOString(),
    ...(value.retiredAt ? { retiredAt: value.retiredAt.toISOString() } : {}),
    ...(value.revokedAt ? { revokedAt: value.revokedAt.toISOString() } : {}),
  })
}

const secretSelect = {
  version: true,
  fingerprint: true,
  status: true,
  createdAt: true,
  retiredAt: true,
  revokedAt: true,
} as const

function record(
  row: V2WebhookEndpoint & { secrets: readonly Parameters<typeof hydrateSecret>[0][] },
): Readonly<WebhookEndpointSummaryRecord> {
  return Object.freeze({
    endpoint: hydrateEndpoint(row),
    ...(row.secrets[0] ? { currentSecret: hydrateSecret(row.secrets[0]) } : {}),
  })
}

export class PrismaWebhookEndpointCommandRepository implements WebhookEndpointCommandRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async setStatus(command: Readonly<SetWebhookEndpointStatusCommand>) {
    try {
      return await this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
        const row = await transaction.v2WebhookEndpoint.findFirst({
          where: { id: command.endpointId, workspaceId: command.workspaceId },
          include: {
            secrets: { select: secretSelect, orderBy: { version: 'desc' }, take: 1 },
          },
        })
        if (!row) return null
        const current = hydrateEndpoint(row)
        if (current.status === command.targetStatus) {
          return Object.freeze({
            endpoint: record(row),
            replayed: true,
            effects: Object.freeze({
              pausedSubscriptions: 0,
              revokedSubscriptions: 0,
              revokedSigningSecrets: 0,
            }),
          })
        }
        if (webhookEndpointRevision(current) !== command.baseRevision) {
          throw new DomainError(
            'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
            'Webhook endpoint revision does not match',
          )
        }
        if (command.targetStatus === 'active') {
          const activeSecrets = await transaction.v2WebhookSigningSecret.count({
            where: {
              endpointId: current.id,
              workspaceId: current.workspaceId,
              status: 'active',
            },
          })
          if (activeSecrets !== 1) {
            throw new DomainError(
              'WEBHOOK_ENDPOINT_TRANSITION_REJECTED',
              'Webhook endpoint requires exactly one active signing secret',
            )
          }
        }
        const cascadeClockConflict = await transaction.v2WebhookSubscription.findFirst({
          where: {
            endpointId: current.id,
            workspaceId: current.workspaceId,
            status: { in: ['pending-verification', 'active', 'paused'] },
            updatedAt: { gt: new Date(command.changedAt) },
          },
          select: { id: true },
        })
        if (cascadeClockConflict) {
          throw new DomainError(
            'WEBHOOK_ENDPOINT_TRANSITION_REJECTED',
            'Webhook endpoint transition clock is stale for its subscriptions',
          )
        }
        const next = transitionWebhookEndpoint(current, command.targetStatus, command.changedAt)
        const changed = await transaction.v2WebhookEndpoint.updateMany({
          where: {
            id: current.id,
            workspaceId: current.workspaceId,
            status: current.status,
            updatedAt: row.updatedAt,
          },
          data: {
            status: next.status,
            updatedAt: new Date(next.updatedAt),
            suspendedAt: next.suspendedAt ? new Date(next.suspendedAt) : null,
            revokedAt: next.revokedAt ? new Date(next.revokedAt) : null,
          },
        })
        if (changed.count !== 1) {
          throw new DomainError(
            'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
            'Webhook endpoint changed concurrently',
          )
        }
        let pausedSubscriptions = 0
        let revokedSubscriptions = 0
        let revokedSigningSecrets = 0
        if (next.status === 'suspended') {
          pausedSubscriptions = (await transaction.v2WebhookSubscription.updateMany({
            where: {
              endpointId: current.id,
              workspaceId: current.workspaceId,
              status: 'active',
            },
            data: {
              status: 'paused',
              pausedAt: new Date(next.updatedAt),
              updatedAt: new Date(next.updatedAt),
            },
          })).count
        } else if (next.status === 'revoked') {
          revokedSubscriptions = (await transaction.v2WebhookSubscription.updateMany({
            where: {
              endpointId: current.id,
              workspaceId: current.workspaceId,
              status: { in: ['pending-verification', 'active', 'paused'] },
            },
            data: {
              status: 'revoked',
              revokedAt: new Date(next.updatedAt),
              updatedAt: new Date(next.updatedAt),
            },
          })).count
          revokedSigningSecrets = (await transaction.v2WebhookSigningSecret.updateMany({
            where: {
              endpointId: current.id,
              workspaceId: current.workspaceId,
              status: 'active',
            },
            data: { status: 'revoked', revokedAt: new Date(next.updatedAt) },
          })).count
        }
        const persisted = await transaction.v2WebhookEndpoint.findUniqueOrThrow({
          where: { id: current.id },
          include: {
            secrets: { select: secretSelect, orderBy: { version: 'desc' }, take: 1 },
          },
        })
        return Object.freeze({
          endpoint: record(persisted),
          replayed: false,
          effects: Object.freeze({
            pausedSubscriptions,
            revokedSubscriptions,
            revokedSigningSecrets,
          }),
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034') {
        throw new DomainError(
          'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
          'Webhook endpoint changed concurrently',
        )
      }
      throw error
    }
  }
}
