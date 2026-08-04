import { DomainError, assertDomain } from '../domain/errors.ts'
import type { WebhookSigningSecretRotationRepository } from './ports/webhook-signing-secret-rotation-repository.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import { createWebhookAdministrationCommand } from '../domain/webhook-administration-command.ts'
import { calculateVersionHash } from './version-hash.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function cancelWebhookSigningSecretRotationService(dependencies: {
  repository: WebhookSigningSecretRotationRepository
  clock: () => Date
  createId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    endpointId: string
    rotationId: string
    actor: AuthenticatedExternalActor
    baseRevision: string
  }) {
    const workspaceId = request.workspaceId.trim()
    const endpointId = request.endpointId.trim().toLowerCase()
    const rotationId = request.rotationId.trim().toLowerCase()
    requireScope(request.actor, 'webhooks:admin')
    if (request.actor.workspaceId !== workspaceId) {
      throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
    }
    const actorClientId = request.actor.clientId
    const baseRevision = request.baseRevision.trim().toLowerCase()
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) && SAFE_ID_PATTERN.test(actorClientId) &&
        UUID_V4_PATTERN.test(endpointId) && UUID_V4_PATTERN.test(rotationId),
      'INVALID_ARGUMENT',
      'Webhook signing secret rotation cancellation identity is invalid',
    )
    assertDomain(SHA256_PATTERN.test(baseRevision), 'INVALID_ARGUMENT', 'Webhook endpoint baseRevision is invalid')
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'Webhook signing secret rotation cancellation clock is invalid')
    const audit = materializeActorAuditContext(request.actor)
    const requestFingerprint = calculateVersionHash({
      action: 'webhook-signing-secret-rotation-cancel/v1',
      actorContextHash: audit.contextHash,
      endpointId,
      rotationId,
      baseRevision,
    })
    return dependencies.repository.cancelOrReplay({
      administration: createWebhookAdministrationCommand({
        id: dependencies.createId(),
        workspaceId,
        action: 'webhook-signing-secret-rotation.cancel',
        targetType: 'webhook-signing-secret-rotation',
        targetId: rotationId,
        endpointId,
        audit,
        baseRevision,
        requestFingerprint,
        occurredAt: now.toISOString(),
      }),
      workspaceId,
      endpointId,
      rotationId,
      actorClientId,
      baseRevision,
      cancelledAt: now.toISOString(),
    })
  }
}
