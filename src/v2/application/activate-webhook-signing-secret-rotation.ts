import { assertDomain } from '../domain/errors.ts'
import type { WebhookSigningSecretRotationRepository } from './ports/webhook-signing-secret-rotation-repository.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function activateWebhookSigningSecretRotationService(dependencies: {
  repository: WebhookSigningSecretRotationRepository
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    endpointId: string
    rotationId: string
    actorClientId: string
    baseRevision: string
  }) {
    const workspaceId = request.workspaceId.trim()
    const endpointId = request.endpointId.trim().toLowerCase()
    const rotationId = request.rotationId.trim().toLowerCase()
    const actorClientId = request.actorClientId.trim()
    const baseRevision = request.baseRevision.trim().toLowerCase()
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) && SAFE_ID_PATTERN.test(actorClientId) &&
        UUID_V4_PATTERN.test(endpointId) && UUID_V4_PATTERN.test(rotationId),
      'INVALID_ARGUMENT',
      'Webhook signing secret rotation activation identity is invalid',
    )
    assertDomain(SHA256_PATTERN.test(baseRevision), 'INVALID_ARGUMENT', 'Webhook endpoint baseRevision is invalid')
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'Webhook signing secret rotation activation clock is invalid')
    return dependencies.repository.activateOrReplay({
      workspaceId,
      endpointId,
      rotationId,
      actorClientId,
      baseRevision,
      activatedAt: now.toISOString(),
    })
  }
}
