import type { PrismaClient } from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import type {
  WebhookRegistrationBundle,
  WebhookRegistrationRepository,
} from '../../application/ports/webhook-registration-repository.ts'
import { DomainError } from '../../domain/errors.ts'

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export class PrismaWebhookRegistrationRepository implements WebhookRegistrationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async register(bundle: WebhookRegistrationBundle): Promise<WebhookRegistrationBundle> {
    const { endpoint, secret, subscription } = bundle
    if (
      endpoint.workspaceId !== secret.workspaceId ||
      endpoint.workspaceId !== subscription.workspaceId ||
      endpoint.id !== secret.endpointId ||
      endpoint.id !== subscription.endpointId ||
      endpoint.createdByClientId !== subscription.createdByClientId
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Webhook registration bundle is inconsistent')
    }

    try {
      await this.client.$transaction(async (transaction) => {
        const [workspace, client] = await Promise.all([
          transaction.v2Workspace.findUnique({
            where: { id: endpoint.workspaceId },
            select: { status: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: endpoint.createdByClientId,
              workspaceId: endpoint.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!workspace || workspace.status !== 'active') {
          throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        }
        if (!client) {
          throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')
        }

        await transaction.v2WebhookEndpoint.create({
          data: {
            id: endpoint.id,
            workspaceId: endpoint.workspaceId,
            url: endpoint.url,
            status: endpoint.status,
            createdByClientId: endpoint.createdByClientId,
            createdAt: new Date(endpoint.createdAt),
            verifiedAt: endpoint.verifiedAt ? new Date(endpoint.verifiedAt) : null,
            suspendedAt: endpoint.suspendedAt ? new Date(endpoint.suspendedAt) : null,
            revokedAt: endpoint.revokedAt ? new Date(endpoint.revokedAt) : null,
          },
        })
        await transaction.v2WebhookSigningSecret.create({
          data: {
            id: secret.id,
            workspaceId: secret.workspaceId,
            endpointId: secret.endpointId,
            version: secret.version,
            algorithm: secret.algorithm,
            keyRef: secret.keyRef,
            fingerprint: secret.fingerprint,
            status: secret.status,
            createdAt: new Date(secret.createdAt),
            retiredAt: secret.retiredAt ? new Date(secret.retiredAt) : null,
            revokedAt: secret.revokedAt ? new Date(secret.revokedAt) : null,
          },
        })
        await transaction.v2WebhookSubscription.create({
          data: {
            id: subscription.id,
            workspaceId: subscription.workspaceId,
            endpointId: subscription.endpointId,
            status: subscription.status,
            filterEventTypesJson: JSON.stringify(subscription.filter.eventTypes),
            filterResourceIdsJson: subscription.filter.resourceIds
              ? JSON.stringify(subscription.filter.resourceIds)
              : null,
            filterHash: subscription.filter.hash,
            createdByClientId: subscription.createdByClientId,
            createdAt: new Date(subscription.createdAt),
            pausedAt: subscription.pausedAt ? new Date(subscription.pausedAt) : null,
            revokedAt: subscription.revokedAt ? new Date(subscription.revokedAt) : null,
          },
        })
      })
      return bundle
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Webhook endpoint, secret reference or subscription already exists',
        )
      }
      throw error
    }
  }
}
