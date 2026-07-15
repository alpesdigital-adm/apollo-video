import type { WebhookDeliveryDiagnosticRecord } from './webhook-delivery-query-repository.ts'

export interface WebhookDeliveryReplayCommand {
  idempotencyId: string
  workspaceId: string
  clientId: string
  idempotencyKey: string
  requestFingerprint: string
  deliveryId: string
  requestedAt: string
  nextAttemptAt: string
  expiresAt: string
}

export interface WebhookDeliveryReplayResult {
  diagnostic: Readonly<WebhookDeliveryDiagnosticRecord>
  replayed: boolean
}

export interface WebhookDeliveryReplayRepository {
  replay(
    command: Readonly<WebhookDeliveryReplayCommand>,
  ): Promise<Readonly<WebhookDeliveryReplayResult> | null>
}
