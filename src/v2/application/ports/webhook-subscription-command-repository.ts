import type {
  WebhookSubscription,
  WebhookSubscriptionMutableStatus,
} from '../../domain/webhook.ts'

export interface SetWebhookSubscriptionStatusCommand {
  workspaceId: string
  subscriptionId: string
  targetStatus: WebhookSubscriptionMutableStatus
  baseRevision: string
  changedAt: string
}

export interface SetWebhookSubscriptionStatusResult {
  subscription: Readonly<WebhookSubscription>
  revision: string
  replayed: boolean
}

export interface WebhookSubscriptionCommandRepository {
  setStatus(
    command: Readonly<SetWebhookSubscriptionStatusCommand>,
  ): Promise<Readonly<SetWebhookSubscriptionStatusResult> | null>
}
