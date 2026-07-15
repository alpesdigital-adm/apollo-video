import type {
  WebhookEndpoint,
  WebhookEndpointStatus,
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from '../../domain/webhook.ts'
import type {
  WebhookSigningSecretRotationStatus,
} from '../../domain/webhook-signing-secret-rotation.ts'

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

export interface WebhookSigningSecretRotationMetadata {
  id: string
  endpointId: string
  candidateVersion: number
  fingerprint: string
  status: WebhookSigningSecretRotationStatus
  overlapSeconds: number
  baseRevision: string
  createdAt: string
  expiresAt: string
  activatedAt?: string
  overlapUntil?: string
  cancelledAt?: string
}

export interface WebhookSigningSecretRotationListQuery {
  workspaceId: string
  endpointId: string
  limit: number
  status?: WebhookSigningSecretRotationStatus
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
  listSigningSecretRotations(
    query: Readonly<WebhookSigningSecretRotationListQuery>,
  ): Promise<readonly Readonly<WebhookSigningSecretRotationMetadata>[]>
  findSigningSecretRotationById(
    workspaceId: string,
    endpointId: string,
    rotationId: string,
  ): Promise<Readonly<WebhookSigningSecretRotationMetadata> | null>
}
