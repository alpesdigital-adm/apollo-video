import type { WebhookEndpoint, WebhookSigningSecret } from '../../domain/webhook.ts'
import type { WebhookSigningSecretPayload } from '../../domain/webhook-signing-secret-payload.ts'

export interface WebhookEndpointCreationIdempotency {
  id: string
  workspaceId: string
  clientId: string
  key: string
  requestFingerprint: string
  requestedAt: string
  expiresAt: string
}

export interface WebhookEndpointCreationBundle {
  endpoint: Readonly<WebhookEndpoint>
  secret: Readonly<WebhookSigningSecret>
  secretPayload: Readonly<WebhookSigningSecretPayload>
  idempotency: Readonly<WebhookEndpointCreationIdempotency>
}

export interface WebhookEndpointCreationResult {
  endpoint: Readonly<WebhookEndpoint>
  secret: Readonly<WebhookSigningSecret>
  replayed: boolean
}

export interface WebhookEndpointCreationRepository {
  createOrReplay(
    bundle: Readonly<WebhookEndpointCreationBundle>,
  ): Promise<Readonly<WebhookEndpointCreationResult>>
}
