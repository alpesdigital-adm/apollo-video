import type { WebhookDeliverySummaryRecord } from './webhook-delivery-query-repository.ts'
import type { WebhookAdministrationCommand } from '../../domain/webhook-administration-command.ts'

export type WebhookEventReplayItemStatus =
  | 'scheduled'
  | 'skipped-non-terminal'
  | 'skipped-target-inactive'
  | 'skipped-attempt-limit'

export interface WebhookEventReplayItem {
  status: WebhookEventReplayItemStatus
  delivery: Readonly<WebhookDeliverySummaryRecord>
}

export interface WebhookEventReplayCommand {
  administration: Readonly<WebhookAdministrationCommand>
  idempotencyId: string
  workspaceId: string
  clientId: string
  idempotencyKey: string
  requestFingerprint: string
  eventId: string
  requestedAt: string
  nextAttemptAt: string
  expiresAt: string
  maxDeliveries: number
}

export interface WebhookEventReplayResult {
  eventId: string
  items: readonly Readonly<WebhookEventReplayItem>[]
  replayed: boolean
}

export interface WebhookEventReplayRepository {
  replayEvent(
    command: Readonly<WebhookEventReplayCommand>,
  ): Promise<Readonly<WebhookEventReplayResult> | null>
}
