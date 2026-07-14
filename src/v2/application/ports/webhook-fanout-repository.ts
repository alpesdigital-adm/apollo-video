import type { WebhookDelivery } from '../../domain/webhook.ts'

export interface MaterializeWebhookEventCommand {
  workspaceId: string
  publishedAt: string
  maxAttempts: number
}

export type WebhookFanoutResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      status: 'published'
      workspaceId: string
      eventId: string
      matchedSubscriptions: number
      deliveries: readonly Readonly<WebhookDelivery>[]
      publishedAt: string
    }>

export interface WebhookFanoutRepository {
  materializeNext(
    command: Readonly<MaterializeWebhookEventCommand>,
  ): Promise<WebhookFanoutResult>
}
