import type { SignedWebhookHeaders } from '../../domain/webhook-security.ts'
import type { WebhookDeliveryFence } from './webhook-delivery-repository.ts'

export interface WebhookDeliveryDispatchTarget {
  workspaceId: string
  deliveryId: string
  eventId: string
  endpointId: string
  url: string
  secretKeyRef: string
  secretVersion: number
  secretFingerprint: string
  rawBody: Buffer
}

export type WebhookDeliveryDispatchTargetResult =
  | Readonly<{ status: 'ready'; target: Readonly<WebhookDeliveryDispatchTarget> }>
  | Readonly<{
      status: 'blocked'
      errorCode: 'target_inactive' | 'signing_secret_unavailable'
    }>

export interface WebhookDeliveryDispatchTargetRepository {
  getDispatchTarget(
    fence: Readonly<WebhookDeliveryFence>,
  ): Promise<Readonly<WebhookDeliveryDispatchTargetResult> | null>
}

export interface WebhookSigningSecretProvider {
  // Returns a fresh disposable byte array. The dispatcher zeroes it after copying.
  open(request: Readonly<{
    workspaceId: string
    endpointId: string
    keyRef: string
    version: number
  }>): Promise<Uint8Array>
}

export interface WebhookDeliveryTransportRequest {
  url: string
  eventId: string
  rawBody: Uint8Array
  headers: Readonly<SignedWebhookHeaders>
}

export interface WebhookDeliveryTransportResponse {
  statusCode: number
  responseBodyHash: string
}

export interface WebhookDeliveryTransport {
  send(
    request: Readonly<WebhookDeliveryTransportRequest>,
  ): Promise<Readonly<WebhookDeliveryTransportResponse>>
}
