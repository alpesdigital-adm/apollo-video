import type { WebhookSigningSecretPayload } from '../../domain/webhook-signing-secret-payload.ts'

export interface ProtectWebhookSigningSecretRequest {
  secretId: string
  workspaceId: string
  endpointId: string
  version: number
  keyRef: string
  createdAt: string
}

export interface ProtectedWebhookSigningSecretMaterial {
  fingerprint: string
  payload: Readonly<WebhookSigningSecretPayload>
}

export interface WebhookSigningSecretProtector {
  protect(
    request: Readonly<ProtectWebhookSigningSecretRequest>,
  ): Promise<Readonly<ProtectedWebhookSigningSecretMaterial>>
}
