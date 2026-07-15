import type { WebhookSubscription } from '../../domain/webhook.ts'

export interface WebhookSubscriptionCreationIdempotency {
  id: string
  workspaceId: string
  clientId: string
  key: string
  requestFingerprint: string
  requestedAt: string
  expiresAt: string
}

export interface WebhookSubscriptionCreationBundle {
  subscription: Readonly<WebhookSubscription>
  idempotency: Readonly<WebhookSubscriptionCreationIdempotency>
}

export interface WebhookSubscriptionCreationResult {
  subscription: Readonly<WebhookSubscription>
  replayed: boolean
}

export interface WebhookSubscriptionCreationRepository {
  createOrReplay(
    bundle: Readonly<WebhookSubscriptionCreationBundle>,
  ): Promise<Readonly<WebhookSubscriptionCreationResult>>
}
