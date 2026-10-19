import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, faceSampleIntervalFrames, faceWindowFrames } from '../domain/face-evidence-policy.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { FaceWindowRequestContextRepository } from './ports/perception-producer-request-context.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

/**
 * Queues one bounded window of the owner-accepted V9 face detector. The cadence is server-owned: it follows the
 * pinned evidence policy and the plan's frame rate, never the caller. A window that cannot hold a sampled frame, or
 * that is longer than the policy allows, is refused here, before anything is queued.
 */
export function enqueueFaceWindowRunService(dependencies: {
  context: FaceWindowRequestContextRepository
  operations: PublicOperationRepository
  createOperationId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: {
    workspaceId: string; projectId: string; projectVersionId: string; sourceArtifactId: string
    window: Readonly<{ startTimelineFrame: number; endTimelineFrame: number }>
    actor: AuthenticatedExternalActor; idempotencyKey: string; traceId?: string
  }) => {
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    if (audit.workspaceId !== request.workspaceId ||
        [request.workspaceId, request.projectId, request.projectVersionId,
          request.sourceArtifactId].some((id) => !ID.test(id))) {
      throw new DomainError('AUTH_INVALID', 'Face window request identity is invalid')
    }
    const idempotencyKey = request.idempotencyKey.trim()
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is required')
    }
    const { startTimelineFrame: start, endTimelineFrame: end } = request.window
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
        end - start > FACE_EVIDENCE_POLICY.sampling.maxWindowFrames) {
      throw new DomainError('INVALID_ARGUMENT', 'Face window must be 1 through 300 timeline frames')
    }
    // The cadence is a function of the version's frame rate and the pinned policy, both fixed by projectVersionId
    // and the policy hash, so the fingerprint can be taken before the context is read.
    const requestFingerprint = calculateCanonicalHash({
      kind: 'perception-face-window-run/v1', detectorProfile: 'openvino-face0204-v9',
      policySha256: FACE_EVIDENCE_POLICY_SHA256, workspaceId: request.workspaceId,
      projectId: request.projectId, projectVersionId: request.projectVersionId,
      sourceArtifactId: request.sourceArtifactId, window: { startTimelineFrame: start, endTimelineFrame: end },
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
    if (!context) throw new DomainError('PRECONDITION_REQUIRED',
      'Current single-clip unit-rate source version and editorial rights are required')
    const sampleIntervalFrames = faceSampleIntervalFrames({ num: context.timelineFps, den: 1 })
    if (end > context.timelineDurationFrames || end - start > faceWindowFrames(sampleIntervalFrames)) {
      throw new DomainError('INVALID_ARGUMENT', 'Face window is outside the timeline or longer than the policy allows')
    }
    const firstSample = Math.ceil((context.clipSourceInFrame + start) / sampleIntervalFrames) * sampleIntervalFrames
    if (firstSample >= context.clipSourceInFrame + end) {
      throw new DomainError('INVALID_ARGUMENT', 'Face window contains no sampled frame')
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
        detectorProfile: 'openvino-face0204-v9', window: Object.freeze({ startTimelineFrame: start, endTimelineFrame: end }) },
      idempotencyKey, requestFingerprint,
      ...(request.traceId ? { traceId: request.traceId } : {}),
    })
  }
}
