import { DomainError, assertDomain } from '../domain/errors.ts'
import { webhookEndpointRevision } from '../domain/webhook.ts'
import { createWebhookSigningSecretRotation } from '../domain/webhook-signing-secret-rotation.ts'
import type { WebhookSigningSecretProtector } from './ports/webhook-signing-secret-protector.ts'
import type { WebhookSigningSecretRotationRepository } from './ports/webhook-signing-secret-rotation-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VISIBLE_ASCII = /^[\x21-\x7e]+$/

export type WebhookSecretRotationEntityKind = 'webhook-secret-rotation' | 'webhook-secret' | 'idempotency-record'

export function stageWebhookSigningSecretRotationService(dependencies: {
  repository: WebhookSigningSecretRotationRepository
  secrets: WebhookSigningSecretProtector
  clock: () => Date
  createId: (kind: WebhookSecretRotationEntityKind) => string
}) {
  return async function execute(request: {
    workspaceId: string
    endpointId: string
    actorClientId: string
    baseRevision: string
    overlapSeconds: number
    idempotencyKey: string
    stageTtlSeconds?: number
  }) {
    const workspaceId = request.workspaceId.trim()
    const endpointId = request.endpointId.trim().toLowerCase()
    const actorClientId = request.actorClientId.trim()
    const baseRevision = request.baseRevision.trim().toLowerCase()
    const idempotencyKey = request.idempotencyKey.trim()
    const stageTtlSeconds = request.stageTtlSeconds ?? 24 * 60 * 60
    assertDomain(SAFE_ID_PATTERN.test(workspaceId) && SAFE_ID_PATTERN.test(actorClientId) && UUID_V4_PATTERN.test(endpointId), 'INVALID_ARGUMENT', 'Webhook signing secret rotation identity is invalid')
    assertDomain(SHA256_PATTERN.test(baseRevision), 'INVALID_ARGUMENT', 'Webhook endpoint baseRevision is invalid')
    assertDomain(idempotencyKey.length >= 1 && idempotencyKey.length <= 128 && VISIBLE_ASCII.test(idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 visible ASCII characters')
    assertDomain(Number.isInteger(request.overlapSeconds) && request.overlapSeconds >= 60 && request.overlapSeconds <= 86_400, 'INVALID_ARGUMENT', 'overlapSeconds must be between 60 and 86400')
    assertDomain(Number.isInteger(stageTtlSeconds) && stageTtlSeconds >= 300 && stageTtlSeconds <= 7 * 24 * 60 * 60, 'INVALID_ARGUMENT', 'stageTtlSeconds must be between 300 seconds and 7 days')

    const target = await dependencies.repository.getTarget(workspaceId, endpointId)
    if (!target) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
    if (target.endpoint.status !== 'active') {
      throw new DomainError('WEBHOOK_ENDPOINT_TRANSITION_REJECTED', 'Only an active webhook endpoint can stage a signing secret rotation')
    }
    if (webhookEndpointRevision(target.endpoint) !== baseRevision) {
      throw new DomainError('WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'Webhook endpoint revision does not match')
    }
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'Webhook signing secret rotation clock is invalid')
    const createdAt = now.toISOString()
    const candidateSecretId = dependencies.createId('webhook-secret')
    const candidateVersion = target.latestSecretVersion + 1
    const keyRef = `vault://apollo/webhooks/${candidateSecretId}`
    const protectedSecret = await dependencies.secrets.protectForOneTimeDisclosure({
      secretId: candidateSecretId,
      workspaceId,
      endpointId,
      version: candidateVersion,
      keyRef,
      createdAt,
    })
    const rotation = createWebhookSigningSecretRotation({
      id: dependencies.createId('webhook-secret-rotation'),
      workspaceId,
      endpointId,
      requestedByClientId: actorClientId,
      previousSecretId: target.activeSecret.id,
      candidateSecretId,
      candidateVersion,
      keyRef,
      fingerprint: protectedSecret.fingerprint,
      status: 'staged',
      overlapSeconds: request.overlapSeconds,
      baseRevision,
      createdAt,
      expiresAt: new Date(now.getTime() + stageTtlSeconds * 1_000).toISOString(),
    })
    const result = await dependencies.repository.stageOrReplay({
      rotation,
      candidatePayload: protectedSecret.payload,
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        key: idempotencyKey,
        requestFingerprint: calculateVersionHash({ action: 'webhook-signing-secret-rotation-stage/v1', endpointId, baseRevision, overlapSeconds: request.overlapSeconds }),
        requestedAt: createdAt,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      },
    })
    return Object.freeze({
      ...result,
      secretAvailable: !result.replayed,
      ...(result.replayed ? {} : { secretBase64url: protectedSecret.secretBase64url }),
    })
  }
}
