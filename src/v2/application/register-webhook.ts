import {
  createWebhookEndpoint,
  createWebhookSigningSecret,
  createWebhookSubscription,
} from '../domain/webhook.ts'
import type {
  WebhookRegistrationBundle,
  WebhookRegistrationRepository,
} from './ports/webhook-registration-repository.ts'

export type WebhookRegistrationEntityKind =
  | 'webhook-endpoint'
  | 'webhook-secret'
  | 'webhook-subscription'

export interface RegisterWebhookRequest {
  workspaceId: string
  url: string
  eventTypes: readonly string[]
  resourceIds?: readonly string[]
  createdByClientId: string
  secret: {
    keyRef: string
    fingerprint: string
  }
}

export interface RegisterWebhookDependencies {
  repository: WebhookRegistrationRepository
  clock: () => Date
  createId: (kind: WebhookRegistrationEntityKind) => string
}

export function registerWebhookService(dependencies: RegisterWebhookDependencies) {
  return async function execute(
    request: RegisterWebhookRequest,
  ): Promise<WebhookRegistrationBundle> {
    const createdAt = dependencies.clock().toISOString()
    const endpointId = dependencies.createId('webhook-endpoint')
    const endpoint = createWebhookEndpoint({
      id: endpointId,
      workspaceId: request.workspaceId,
      url: request.url,
      status: 'pending-verification',
      createdByClientId: request.createdByClientId,
      createdAt,
    })
    const secret = createWebhookSigningSecret({
      id: dependencies.createId('webhook-secret'),
      workspaceId: endpoint.workspaceId,
      endpointId: endpoint.id,
      version: 1,
      keyRef: request.secret.keyRef,
      fingerprint: request.secret.fingerprint,
      status: 'active',
      createdAt,
    })
    const subscription = createWebhookSubscription({
      id: dependencies.createId('webhook-subscription'),
      workspaceId: endpoint.workspaceId,
      endpointId: endpoint.id,
      status: 'pending-verification',
      filter: {
        eventTypes: request.eventTypes,
        ...(request.resourceIds ? { resourceIds: request.resourceIds } : {}),
      },
      createdByClientId: request.createdByClientId,
      createdAt,
    })

    return dependencies.repository.register({ endpoint, secret, subscription })
  }
}
