import type { WebhookEndpoint, WebhookSigningSecret } from '../../domain/webhook.ts'
import type { WebhookSigningSecretPayload } from '../../domain/webhook-signing-secret-payload.ts'
import type { WebhookSigningSecretRotation } from '../../domain/webhook-signing-secret-rotation.ts'

export interface WebhookSigningSecretRotationTarget {
  endpoint: Readonly<WebhookEndpoint>
  activeSecret: Readonly<WebhookSigningSecret>
  latestSecretVersion: number
}

export interface StageWebhookSigningSecretRotationCommand {
  rotation: Readonly<WebhookSigningSecretRotation>
  candidatePayload: Readonly<WebhookSigningSecretPayload>
  idempotency: Readonly<{
    id: string
    key: string
    requestFingerprint: string
    requestedAt: string
    expiresAt: string
  }>
}

export interface StageWebhookSigningSecretRotationResult {
  endpoint: Readonly<WebhookEndpoint>
  rotation: Readonly<WebhookSigningSecretRotation>
  replayed: boolean
}

export interface ActivateWebhookSigningSecretRotationCommand {
  workspaceId: string
  endpointId: string
  rotationId: string
  actorClientId: string
  baseRevision: string
  activatedAt: string
}

export interface ActivateWebhookSigningSecretRotationResult {
  endpoint: Readonly<WebhookEndpoint>
  rotation: Readonly<WebhookSigningSecretRotation>
  previousSecret: Readonly<WebhookSigningSecret>
  activatedSecret: Readonly<WebhookSigningSecret>
  replayed: boolean
}

export interface CancelWebhookSigningSecretRotationCommand {
  workspaceId: string
  endpointId: string
  rotationId: string
  actorClientId: string
  baseRevision: string
  cancelledAt: string
}

export interface CancelWebhookSigningSecretRotationResult {
  rotation: Readonly<WebhookSigningSecretRotation>
  replayed: boolean
}

export interface WebhookSigningSecretRotationRepository {
  getTarget(workspaceId: string, endpointId: string): Promise<Readonly<WebhookSigningSecretRotationTarget> | null>
  stageOrReplay(command: Readonly<StageWebhookSigningSecretRotationCommand>): Promise<Readonly<StageWebhookSigningSecretRotationResult>>
  activateOrReplay(command: Readonly<ActivateWebhookSigningSecretRotationCommand>): Promise<Readonly<ActivateWebhookSigningSecretRotationResult>>
  cancelOrReplay(command: Readonly<CancelWebhookSigningSecretRotationCommand>): Promise<Readonly<CancelWebhookSigningSecretRotationResult>>
}
