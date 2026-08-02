import type { MediaArtifactLifecycleTransitionRecord } from '../application/ports/media-artifact-lifecycle-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { presentMediaArtifactVisibleState } from '../domain/visible-state.ts'

export function parseMediaArtifactLifecycleTransitionBody(raw: unknown): Readonly<{
  baseRevision: number
  targetStatus: 'available' | 'quarantined' | 'deleted'
  reason: string
}> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  }
  const body = raw as Record<string, unknown>
  const keys = Object.keys(body).sort()
  if (keys.join(',') !== 'baseRevision,reason,targetStatus') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Request body must contain only baseRevision, targetStatus and reason',
    )
  }
  if (!Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 1) {
    throw new DomainError('INVALID_ARGUMENT', 'baseRevision must be a positive integer')
  }
  if (!['available', 'quarantined', 'deleted'].includes(body.targetStatus as string)) {
    throw new DomainError('INVALID_ARGUMENT', 'targetStatus is invalid')
  }
  if (typeof body.reason !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', 'reason must be a string')
  }
  return Object.freeze({
    baseRevision: body.baseRevision as number,
    targetStatus: body.targetStatus as 'available' | 'quarantined' | 'deleted',
    reason: body.reason,
  })
}

export function presentMediaArtifactLifecycleTransition(
  transition: Readonly<MediaArtifactLifecycleTransitionRecord>,
) {
  return Object.freeze({
    id: transition.id,
    artifactId: transition.artifactId,
    baseRevision: transition.baseRevision,
    resultRevision: transition.resultRevision,
    fromStatus: transition.fromStatus,
    targetStatus: transition.targetStatus,
    changed: transition.changed,
    reason: transition.reason,
    actorClientId: transition.actorClientId,
    visibleState: presentMediaArtifactVisibleState(transition.targetStatus),
    createdAt: transition.createdAt,
  })
}
