import type { WebhookDelivery, WebhookDeliveryAttempt } from '../../domain/webhook.ts'

export interface WebhookDeliveryLease {
  owner: string
  attemptNumber: number
  heartbeatAt: string
  expiresAt: string
}

export interface ClaimedWebhookDelivery {
  delivery: Readonly<WebhookDelivery>
  attempt: Readonly<WebhookDeliveryAttempt>
  lease: Readonly<WebhookDeliveryLease>
}

export interface SettledWebhookDelivery {
  delivery: Readonly<WebhookDelivery>
  attempt: Readonly<WebhookDeliveryAttempt>
}

export interface WebhookDeliveryFence {
  workspaceId: string
  deliveryId: string
  leaseOwner: string
  leaseTokenHash: string
  attemptNumber: number
  now: string
}

export interface WebhookDeliveryRepository {
  claimNext(command: Readonly<{
    workspaceId: string
    leaseOwner: string
    leaseTokenHash: string
    attemptId: string
    now: string
    leaseUntil: string
  }>): Promise<Readonly<ClaimedWebhookDelivery> | null>
  heartbeat(command: Readonly<WebhookDeliveryFence & { leaseUntil: string }>): Promise<boolean>
  succeed(command: Readonly<WebhookDeliveryFence & {
    responseStatus: number
    responseBodyHash?: string
  }>): Promise<Readonly<SettledWebhookDelivery> | null>
  failOrRetry(command: Readonly<WebhookDeliveryFence & {
    responseStatus?: number
    responseBodyHash?: string
    errorCode?: string
    nextAttemptAt?: string
  }>): Promise<Readonly<SettledWebhookDelivery> | null>
}
