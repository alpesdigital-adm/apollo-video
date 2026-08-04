import type { WebhookEndpointMutableStatus } from '../../domain/webhook.ts'
import type { WebhookAdministrationCommand } from '../../domain/webhook-administration-command.ts'
import type { WebhookEndpointSummaryRecord } from './webhook-administration-query-repository.ts'

export interface SetWebhookEndpointStatusCommand {
  administration: Readonly<WebhookAdministrationCommand>
  targetStatus: WebhookEndpointMutableStatus
}

export interface SetWebhookEndpointStatusResult {
  endpoint: Readonly<WebhookEndpointSummaryRecord>
  replayed: boolean
  effects: Readonly<{
    pausedSubscriptions: number
    revokedSubscriptions: number
    revokedSigningSecrets: number
  }>
}

export interface WebhookEndpointCommandRepository {
  setStatus(
    command: Readonly<SetWebhookEndpointStatusCommand>,
  ): Promise<Readonly<SetWebhookEndpointStatusResult> | null>
}
