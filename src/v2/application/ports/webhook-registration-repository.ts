import type {
  WebhookEndpoint,
  WebhookSigningSecret,
  WebhookSubscription,
} from '../../domain/webhook.ts'

export interface WebhookRegistrationBundle {
  endpoint: Readonly<WebhookEndpoint>
  secret: Readonly<WebhookSigningSecret>
  subscription: Readonly<WebhookSubscription>
}

export interface WebhookRegistrationRepository {
  register(bundle: WebhookRegistrationBundle): Promise<WebhookRegistrationBundle>
}
