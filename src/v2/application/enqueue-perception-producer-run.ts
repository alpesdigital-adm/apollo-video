import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { PerceptionProducerRequestContextRepository } from './ports/perception-producer-request-context.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export function enqueuePerceptionProducerRunService(dependencies: {
  context: PerceptionProducerRequestContextRepository
  operations: PublicOperationRepository
  createOperationId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    sourceArtifactId: string
    sampleIntervalFrames?: number
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    traceId?: string
  }) => {
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    const ids = [request.workspaceId, request.projectId, request.projectVersionId,
      request.sourceArtifactId]
    if (audit.workspaceId !== request.workspaceId || ids.some((id) => !ID.test(id))) {
      throw new DomainError('AUTH_INVALID', 'Perception producer request identity is invalid')
    }
    const idempotencyKey = request.idempotencyKey.trim()
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is required')
    }
    const sampleIntervalFrames = request.sampleIntervalFrames ?? 30
    if (!Number.isSafeInteger(sampleIntervalFrames) || sampleIntervalFrames < 1 || sampleIntervalFrames > 300) {
      throw new DomainError('INVALID_ARGUMENT', 'sampleIntervalFrames must be 1 through 300')
    }
    const requestFingerprint = calculateCanonicalHash({
      kind: 'perception-producer-run/v1', workspaceId: request.workspaceId,
      projectId: request.projectId, projectVersionId: request.projectVersionId,
      sourceArtifactId: request.sourceArtifactId, sampleIntervalFrames,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.operations.findReplay({
      workspaceId: request.workspaceId, clientId: audit.clientId,
      actorContextHash: audit.contextHash, idempotencyKey, requestFingerprint,
    })
    if (replay) return replay
    const context = await dependencies.context.read({
      workspaceId: request.workspaceId, projectId: request.projectId,
      projectVersionId: request.projectVersionId, sourceArtifactId: request.sourceArtifactId,
    })
    if (!context) throw new DomainError('PRECONDITION_REQUIRED', 'Current source version and editorial rights are required')
    const operation = createQueuedPublicOperation({
      id: dependencies.createOperationId(), workspaceId: request.workspaceId,
      projectId: request.projectId, clientId: audit.clientId,
      type: 'perception-producer-run',
      target: { type: 'project-version', id: context.projectVersionId },
      createdAt: clock().toISOString(),
    })
    return dependencies.operations.createOrReplay({
      operation, authenticationAudit: audit,
      context: { kind: 'perception-producer-run', ...context,
        sampleIntervalFrames, requestHash: requestFingerprint },
      idempotencyKey, requestFingerprint,
      ...(request.traceId ? { traceId: request.traceId } : {}),
    })
  }
}
