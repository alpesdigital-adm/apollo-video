import type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryStatus,
} from '../../domain/webhook.ts'

export interface WebhookDeliverySummaryRecord {
  delivery: Readonly<WebhookDelivery>
  endpointId: string
}

export interface WebhookDeliveryDiagnosticRecord extends WebhookDeliverySummaryRecord {
  attempts: readonly Readonly<WebhookDeliveryAttempt>[]
}

export interface WebhookDeliveryListQuery {
  workspaceId: string
  limit: number
  status?: WebhookDeliveryStatus
  endpointId?: string
  eventId?: string
  after?: Readonly<{ createdAt: string; id: string }>
}

export interface WebhookDeliveryQueryRepository {
  list(
    query: Readonly<WebhookDeliveryListQuery>,
  ): Promise<readonly Readonly<WebhookDeliverySummaryRecord>[]>
  findDiagnosticById(
    workspaceId: string,
    deliveryId: string,
  ): Promise<Readonly<WebhookDeliveryDiagnosticRecord> | null>
}
