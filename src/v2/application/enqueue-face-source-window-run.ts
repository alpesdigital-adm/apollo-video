import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, faceSampleIntervalFrames, faceWindowFrames } from '../domain/face-evidence-policy.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { FaceSourceWindowRequestContextRepository } from './ports/face-source-window-request-context.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

/**
 * Queues one bounded window of the SOURCE's own frames for the owner-accepted V9 face detector (W65b). The evidence is about the
 * bytes of the source, so the request names no Version and no timeline range: the project it is made from only says who may ask, with
 * which rights locale. The cadence is server-owned: it follows the pinned evidence policy and the SOURCE's frame rate, never the caller.
 * A window that cannot hold a sampled frame, that is longer than the policy allows or that reaches past the source is refused here,
 * before anything is queued.
 */
export function enqueueFaceSourceWindowRunService(dependencies: {
  context: FaceSourceWindowRequestContextRepository
  operations: PublicOperationRepository
  createOperationId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: {
    workspaceId: string; projectId: string; sourceArtifactId: string
    window: Readonly<{ startSourceFrame: number; endSourceFrame: number }>
    actor: AuthenticatedExternalActor; idempotencyKey: string; traceId?: string
  }) => {
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    if (audit.workspaceId !== request.workspaceId ||
        [request.workspaceId, request.projectId, request.sourceArtifactId].some((id) => !ID.test(id))) {
      throw new DomainError('AUTH_INVALID', 'Face source window request identity is invalid')
    }
    const idempotencyKey = request.idempotencyKey.trim()
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is required')
    }
    const { startSourceFrame: start, endSourceFrame: end } = request.window
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
        end - start > FACE_EVIDENCE_POLICY.sampling.maxWindowFrames) {
      throw new DomainError('INVALID_ARGUMENT', 'Face source window must be 1 through 300 source frames')
    }
    // Nothing about the Version the request happens to be made under is part of what is asked, so it is not in the fingerprint.
    const requestFingerprint = calculateCanonicalHash({
      kind: 'perception-face-source-window-run/v1', detectorProfile: 'openvino-face0204-v9-source',
      policySha256: FACE_EVIDENCE_POLICY_SHA256, workspaceId: request.workspaceId,
      projectId: request.projectId, sourceArtifactId: request.sourceArtifactId,
      window: { startSourceFrame: start, endSourceFrame: end }, actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.operations.findReplay({
      workspaceId: request.workspaceId, clientId: audit.clientId,
      actorContextHash: audit.contextHash, idempotencyKey, requestFingerprint,
    })
    if (replay) return replay
    const context = await dependencies.context.read({
      workspaceId: request.workspaceId, projectId: request.projectId, sourceArtifactId: request.sourceArtifactId,
    })
    if (!context) throw new DomainError('PRECONDITION_REQUIRED',
      'A source the project plays, attached to it, with an integer frame rate and analysis rights is required')
    const sampleIntervalFrames = faceSampleIntervalFrames({ num: context.sourceFps, den: 1 })
    if (end > context.sourceDurationFrames || end - start > faceWindowFrames(sampleIntervalFrames)) {
      throw new DomainError('INVALID_ARGUMENT', 'Face source window is outside the source or longer than the policy allows')
    }
    if (Math.ceil(start / sampleIntervalFrames) * sampleIntervalFrames >= end) {
      throw new DomainError('INVALID_ARGUMENT', 'Face source window contains no sampled frame')
    }
    const operation = createQueuedPublicOperation({
      id: dependencies.createOperationId(), workspaceId: request.workspaceId,
      projectId: request.projectId, clientId: audit.clientId,
      type: 'perception-face-run',
      target: { type: 'project-version', id: context.projectVersionId },
      createdAt: clock().toISOString(),
    })
    return dependencies.operations.createOrReplay({
      operation, authenticationAudit: audit,
      context: { kind: 'perception-face-run', projectId: context.projectId,
        projectVersionId: context.projectVersionId, projectVersionHash: context.projectVersionHash,
        sourceArtifactId: context.sourceArtifactId, sourceSha256: context.sourceSha256,
        editPlanSnapshotId: context.editPlanSnapshotId, editPlanSnapshotHash: context.editPlanSnapshotHash,
        sampleIntervalFrames, requestHash: requestFingerprint,
        detectorProfile: 'openvino-face0204-v9-source',
        sourceWindow: Object.freeze({ startSourceFrame: start, endSourceFrame: end }) },
      idempotencyKey, requestFingerprint,
      ...(request.traceId ? { traceId: request.traceId } : {}),
    })
  }
}
