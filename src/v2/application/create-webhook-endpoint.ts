import { assertDomain } from '../domain/errors.ts'
import { createWebhookEndpoint, createWebhookSigningSecret } from '../domain/webhook.ts'
import type {
  WebhookEndpointCreationRepository,
  WebhookEndpointCreationResult,
} from './ports/webhook-endpoint-creation-repository.ts'
import type { WebhookSigningSecretProtector } from './ports/webhook-signing-secret-protector.ts'
import { calculateVersionHash } from './version-hash.ts'

export type WebhookEndpointCreationEntityKind =
  | 'webhook-endpoint'
  | 'webhook-secret'
  | 'idempotency-record'

export interface CreateWebhookEndpointRequest {
  workspaceId: string
  url: string
  createdByClientId: string
  idempotencyKey: string
  idempotencyTtlSeconds?: number
}

export interface CreateWebhookEndpointDependencies {
  repository: WebhookEndpointCreationRepository
  secrets: WebhookSigningSecretProtector
  clock: () => Date
  createId: (kind: WebhookEndpointCreationEntityKind) => string
}

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60
const VISIBLE_ASCII = /^[\x21-\x7e]+$/

export function createWebhookEndpointService(dependencies: CreateWebhookEndpointDependencies) {
  return async function execute(
    request: CreateWebhookEndpointRequest,
  ): Promise<Readonly<WebhookEndpointCreationResult>> {
    const workspaceId = request.workspaceId.trim()
    const clientId = request.createdByClientId.trim()
    const idempotencyKey = request.idempotencyKey.trim()
    const ttlSeconds = request.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS
    assertDomain(workspaceId.length > 0, 'INVALID_ARGUMENT', 'workspaceId is required')
    assertDomain(clientId.length > 0, 'INVALID_ARGUMENT', 'createdByClientId is required')
    assertDomain(idempotencyKey.length >= 1 && idempotencyKey.length <= 128 && VISIBLE_ASCII.test(idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 visible ASCII characters')
    assertDomain(Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 7 * 24 * 60 * 60, 'INVALID_ARGUMENT', 'idempotency ttlSeconds must be between 60 seconds and 7 days')

    const now = dependencies.clock()
    const createdAt = now.toISOString()
    const endpointId = dependencies.createId('webhook-endpoint')
    const secretId = dependencies.createId('webhook-secret')
    const endpoint = createWebhookEndpoint({
      id: endpointId,
      workspaceId,
      url: request.url,
      status: 'pending-verification',
      createdByClientId: clientId,
      createdAt,
    })
    const keyRef = `vault://apollo/webhooks/${secretId}`
    const protectedSecret = await dependencies.secrets.protect({
      secretId,
      workspaceId,
      endpointId,
      version: 1,
      keyRef,
      createdAt,
    })
    const secret = createWebhookSigningSecret({
      id: secretId,
      workspaceId,
      endpointId,
      version: 1,
      keyRef,
      fingerprint: protectedSecret.fingerprint,
      status: 'active',
      createdAt,
    })
    const requestFingerprint = calculateVersionHash({
      action: 'webhook-endpoint-create/v1',
      url: endpoint.url,
    })
    return dependencies.repository.createOrReplay({
      endpoint,
      secret,
      secretPayload: protectedSecret.payload,
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        workspaceId,
        clientId,
        key: idempotencyKey,
        requestFingerprint,
        requestedAt: createdAt,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
      },
    })
  }
}
