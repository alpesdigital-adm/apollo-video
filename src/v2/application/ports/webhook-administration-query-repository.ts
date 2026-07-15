import type {
  WebhookEndpoint,
  WebhookEndpointStatus,
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from '../../domain/webhook.ts'

export interface WebhookSigningSecretMetadata {
  version: number
  fingerprint: string
  status: 'active' | 'retired' | 'revoked'
  createdAt: string
  retiredAt?: string
  revokedAt?: string
}

export interface WebhookEndpointSummaryRecord {
  endpoint: Readonly<WebhookEndpoint>
  currentSecret?: Readonly<WebhookSigningSecretMetadata>
}

export interface WebhookEndpointDetailRecord extends WebhookEndpointSummaryRecord {
  signingSecrets: readonly Readonly<WebhookSigningSecretMetadata>[]
}

export interface WebhookEndpointListQuery {
  workspaceId: string
  limit: number
  status?: WebhookEndpointStatus
  after?: Readonly<{ createdAt: string; id: string }>
}

export interface WebhookSubscriptionListQuery {
  workspaceId: string
  limit: number
  status?: WebhookSubscriptionStatus
  endpointId?: string
  after?: Readonly<{ createdAt: string; id: string }>
}

export interface WebhookAdministrationQueryRepository {
  listEndpoints(
    query: Readonly<WebhookEndpointListQuery>,
  ): Promise<readonly Readonly<WebhookEndpointSummaryRecord>[]>
  findEndpointById(
    workspaceId: string,
    endpointId: string,
  ): Promise<Readonly<WebhookEndpointDetailRecord> | null>
  listSubscriptions(
    query: Readonly<WebhookSubscriptionListQuery>,
  ): Promise<readonly Readonly<WebhookSubscription>[]>
  findSubscriptionById(
    workspaceId: string,
    subscriptionId: string,
  ): Promise<Readonly<WebhookSubscription> | null>
}
