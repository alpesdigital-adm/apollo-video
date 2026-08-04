import type {
  WebhookSubscription,
  WebhookSubscriptionMutableStatus,
} from '../../domain/webhook.ts'
import type { WebhookAdministrationCommand } from '../../domain/webhook-administration-command.ts'

export interface SetWebhookSubscriptionStatusCommand {
  administration: Readonly<WebhookAdministrationCommand>
  targetStatus: WebhookSubscriptionMutableStatus
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
