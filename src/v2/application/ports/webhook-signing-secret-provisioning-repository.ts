import type { WebhookEndpoint, WebhookSigningSecret } from '../../domain/webhook.ts'
import type { WebhookSigningSecretPayload } from '../../domain/webhook-signing-secret-payload.ts'

export interface WebhookSigningSecretProvisioningTarget {
  endpoint: Readonly<WebhookEndpoint>
  latestSecretVersion: number
}

export interface WebhookSigningSecretProvisioningCommand {
  workspaceId: string
  endpointId: string
  actorClientId: string
  baseRevision: string
  secret: Readonly<WebhookSigningSecret>
  secretPayload: Readonly<WebhookSigningSecretPayload>
  idempotency: Readonly<{
    id: string
    key: string
    requestFingerprint: string
    requestedAt: string
    expiresAt: string
  }>
}

export interface WebhookSigningSecretProvisioningResult {
  endpoint: Readonly<WebhookEndpoint>
  secret: Readonly<WebhookSigningSecret>
  replayed: boolean
}

export interface WebhookSigningSecretProvisioningRepository {
  getTarget(
    workspaceId: string,
    endpointId: string,
  ): Promise<Readonly<WebhookSigningSecretProvisioningTarget> | null>
  provisionOrReplay(
    command: Readonly<WebhookSigningSecretProvisioningCommand>,
  ): Promise<Readonly<WebhookSigningSecretProvisioningResult>>
}
