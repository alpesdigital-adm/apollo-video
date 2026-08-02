import { assertDomain } from '../domain/errors.ts'
import {
  assertMediaArtifactLifecycleStatus,
  type MediaArtifactLifecycleStatus,
} from '../domain/media-artifact.ts'
import { calculateVersionHash } from './version-hash.ts'
import type {
  MediaArtifactLifecycleRepository,
  MediaArtifactLifecycleTransitionResult,
} from './ports/media-artifact-lifecycle-repository.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7e]{8,128}$/
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

export interface TransitionMediaArtifactLifecycleRequest {
  workspaceId: string
  artifactId: string
  baseRevision: number
  targetStatus: string
  reason: string
  actorClientId: string
  idempotencyKey: string
}

export interface TransitionMediaArtifactLifecycleDependencies {
  repository: MediaArtifactLifecycleRepository
  clock: () => Date
  createId: () => string
}

export function transitionMediaArtifactLifecycleService(
  dependencies: TransitionMediaArtifactLifecycleDependencies,
) {
  return async function transition(
    request: TransitionMediaArtifactLifecycleRequest,
  ): Promise<MediaArtifactLifecycleTransitionResult> {
    const workspaceId = request.workspaceId.trim()
    const artifactId = request.artifactId.trim()
    const actorClientId = request.actorClientId.trim()
    const idempotencyKey = request.idempotencyKey.trim()
    const reason = request.reason.trim().replace(/\s+/g, ' ')
    const targetStatus = request.targetStatus.trim() as MediaArtifactLifecycleStatus

    assertDomain(ID_PATTERN.test(workspaceId), 'INVALID_ARGUMENT', 'workspaceId is invalid')
    assertDomain(ID_PATTERN.test(artifactId), 'INVALID_ARGUMENT', 'artifactId is invalid')
    assertDomain(ID_PATTERN.test(actorClientId), 'INVALID_ARGUMENT', 'actorClientId is invalid')
    assertDomain(
      IDEMPOTENCY_PATTERN.test(idempotencyKey),
      'INVALID_ARGUMENT',
      'Idempotency-Key must contain 8 to 128 visible ASCII characters',
    )
    assertDomain(
      Number.isSafeInteger(request.baseRevision) && request.baseRevision >= 1,
      'INVALID_ARGUMENT',
      'baseRevision must be a positive integer',
    )
    assertDomain(
      reason.length >= 3 && reason.length <= 500,
      'INVALID_ARGUMENT',
      'reason must contain 3 to 500 characters',
    )
    assertMediaArtifactLifecycleStatus(targetStatus)

    const createdAt = dependencies.clock()
    assertDomain(!Number.isNaN(createdAt.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    const requestFingerprint = calculateVersionHash({
      schemaVersion: 'media-artifact-lifecycle-transition-request/v1',
      workspaceId,
      artifactId,
      baseRevision: request.baseRevision,
      targetStatus,
      reason,
      actorClientId,
    })

    return dependencies.repository.transitionOrReplay({
      transitionId: dependencies.createId(),
      idempotencyRecordId: dependencies.createId(),
      workspaceId,
      artifactId,
      baseRevision: request.baseRevision,
      targetStatus,
      reason,
      actorClientId,
      idempotencyKey,
      requestFingerprint,
      createdAt: createdAt.toISOString(),
      idempotencyExpiresAt: new Date(
        createdAt.getTime() + DEFAULT_IDEMPOTENCY_TTL_MS,
      ).toISOString(),
    })
  }
}
