import type { WebhookEndpointMutableStatus } from '../../domain/webhook.ts'
import type { WebhookEndpointSummaryRecord } from './webhook-administration-query-repository.ts'

export interface SetWebhookEndpointStatusCommand {
  workspaceId: string
  endpointId: string
  targetStatus: WebhookEndpointMutableStatus
  baseRevision: string
  changedAt: string
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
