import { DomainError, assertDomain } from '../domain/errors.ts'
import { createWebhookSigningSecret } from '../domain/webhook.ts'
import type { WebhookSigningSecretProtector } from './ports/webhook-signing-secret-protector.ts'
import type { WebhookSigningSecretProvisioningRepository } from './ports/webhook-signing-secret-provisioning-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VISIBLE_ASCII = /^[\x21-\x7e]+$/
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export type WebhookSecretProvisioningEntityKind = 'webhook-secret' | 'idempotency-record'

export function provisionWebhookSigningSecretService(dependencies: {
  repository: WebhookSigningSecretProvisioningRepository
  secrets: WebhookSigningSecretProtector
  clock: () => Date
  createId: (kind: WebhookSecretProvisioningEntityKind) => string
}) {
  return async function execute(request: {
    workspaceId: string
    endpointId: string
    actorClientId: string
    baseRevision: string
    idempotencyKey: string
    idempotencyTtlSeconds?: number
  }) {
    const workspaceId = request.workspaceId.trim()
    const endpointId = request.endpointId.trim().toLowerCase()
    const actorClientId = request.actorClientId.trim()
    const baseRevision = request.baseRevision.trim().toLowerCase()
    const idempotencyKey = request.idempotencyKey.trim()
    const ttlSeconds = request.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) &&
        SAFE_ID_PATTERN.test(actorClientId) &&
        UUID_V4_PATTERN.test(endpointId),
      'INVALID_ARGUMENT',
      'Webhook signing secret provisioning identity is invalid',
    )
    assertDomain(
      SHA256_PATTERN.test(baseRevision),
      'INVALID_ARGUMENT',
      'Webhook endpoint baseRevision is invalid',
    )
    assertDomain(
      idempotencyKey.length >= 1 &&
        idempotencyKey.length <= 128 &&
        VISIBLE_ASCII.test(idempotencyKey),
      'INVALID_ARGUMENT',
      'Idempotency-Key must contain 1 to 128 visible ASCII characters',
    )
    assertDomain(
      Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 7 * 24 * 60 * 60,
      'INVALID_ARGUMENT',
      'idempotency ttlSeconds must be between 60 seconds and 7 days',
    )

    const target = await dependencies.repository.getTarget(workspaceId, endpointId)
    if (!target) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'Webhook secret provisioning clock is invalid')
    assertDomain(
      now.getTime() >= new Date(target.endpoint.updatedAt).getTime(),
      'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
      'Webhook secret provisioning clock is stale',
    )
    const createdAt = now.toISOString()
    const secretId = dependencies.createId('webhook-secret')
    const version = target.latestSecretVersion + 1
    const keyRef = `vault://apollo/webhooks/${secretId}`
    const protectedSecret = await dependencies.secrets.protectForOneTimeDisclosure({
      secretId,
      workspaceId,
      endpointId,
      version,
      keyRef,
      createdAt,
    })
    const secret = createWebhookSigningSecret({
      id: secretId,
      workspaceId,
      endpointId,
      version,
      keyRef,
      fingerprint: protectedSecret.fingerprint,
      status: 'active',
      createdAt,
    })
    const requestFingerprint = calculateVersionHash({
      action: 'webhook-signing-secret-provision/v1',
      endpointId,
      baseRevision,
    })
    const result = await dependencies.repository.provisionOrReplay({
      workspaceId,
      endpointId,
      actorClientId,
      baseRevision,
      secret,
      secretPayload: protectedSecret.payload,
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        key: idempotencyKey,
        requestFingerprint,
        requestedAt: createdAt,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
      },
    })
    assertDomain(
      result.replayed || result.secret.id === secret.id,
      'PERSISTENCE_CONFLICT',
      'Webhook signing secret provisioning returned an unexpected secret',
    )
    return Object.freeze({
      ...result,
      secretAvailable: !result.replayed,
      ...(result.replayed ? {} : { secretBase64url: protectedSecret.secretBase64url }),
    })
  }
}
