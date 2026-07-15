import { assertDomain } from '../domain/errors.ts'
import { createWebhookSubscription } from '../domain/webhook.ts'
import type {
  WebhookSubscriptionCreationRepository,
  WebhookSubscriptionCreationResult,
} from './ports/webhook-subscription-creation-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

export type WebhookSubscriptionCreationEntityKind =
  | 'webhook-subscription'
  | 'idempotency-record'

export interface CreateWebhookSubscriptionRequest {
  workspaceId: string
  endpointId: string
  eventTypes: readonly string[]
  resourceIds?: readonly string[]
  createdByClientId: string
  idempotencyKey: string
  idempotencyTtlSeconds?: number
}

export interface CreateWebhookSubscriptionDependencies {
  repository: WebhookSubscriptionCreationRepository
  clock: () => Date
  createId: (kind: WebhookSubscriptionCreationEntityKind) => string
}

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60
const PRINTABLE_IDEMPOTENCY_KEY = /^[\x21-\x7e]+$/

export function createWebhookSubscriptionService(
  dependencies: CreateWebhookSubscriptionDependencies,
) {
  return async function execute(
    request: CreateWebhookSubscriptionRequest,
  ): Promise<Readonly<WebhookSubscriptionCreationResult>> {
    const workspaceId = request.workspaceId.trim()
    const endpointId = request.endpointId.trim()
    const clientId = request.createdByClientId.trim()
    const idempotencyKey = request.idempotencyKey.trim()
    const ttlSeconds = request.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS

    assertDomain(workspaceId.length > 0, 'INVALID_ARGUMENT', 'workspaceId is required')
    assertDomain(clientId.length > 0, 'INVALID_ARGUMENT', 'createdByClientId is required')
    assertDomain(
      idempotencyKey.length >= 1 && idempotencyKey.length <= 128 && PRINTABLE_IDEMPOTENCY_KEY.test(idempotencyKey),
      'INVALID_ARGUMENT',
      'Idempotency-Key must contain 1 to 128 printable ASCII characters',
    )
    assertDomain(
      Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 7 * 24 * 60 * 60,
      'INVALID_ARGUMENT',
      'idempotency ttlSeconds must be between 60 seconds and 7 days',
    )

    const now = dependencies.clock()
    const createdAt = now.toISOString()
    const subscription = createWebhookSubscription({
      id: dependencies.createId('webhook-subscription'),
      workspaceId,
      endpointId,
      status: 'active',
      filter: {
        eventTypes: request.eventTypes,
        ...(request.resourceIds ? { resourceIds: request.resourceIds } : {}),
      },
      createdByClientId: clientId,
      createdAt,
    })
    const requestFingerprint = calculateVersionHash({
      action: 'webhook-subscription-create/v1',
      endpointId: subscription.endpointId,
      filterHash: subscription.filter.hash,
    })

    return dependencies.repository.createOrReplay({
      subscription,
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        workspaceId,
        clientId,
        key: idempotencyKey,
        requestFingerprint,
        requestedAt: createdAt,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      },
    })
  }
}
