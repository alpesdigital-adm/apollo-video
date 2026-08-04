import type { MediaArtifactLifecycleStatus } from '../../domain/media-artifact.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface MediaArtifactLifecycleTransitionRecord {
  id: string
  workspaceId: string
  artifactId: string
  baseRevision: number
  resultRevision: number
  fromStatus: MediaArtifactLifecycleStatus
  targetStatus: MediaArtifactLifecycleStatus
  changed: boolean
  reason: string
  actorClientId: string
  audit: Readonly<ApiAccessAuditContext>
  idempotencyKey: string
  requestFingerprint: string
  createdAt: string
}

export interface MediaArtifactLifecycleTransitionBundle {
  transitionId: string
  idempotencyRecordId: string
  workspaceId: string
  artifactId: string
  baseRevision: number
  targetStatus: MediaArtifactLifecycleStatus
  reason: string
  audit: Readonly<ApiAccessAuditContext>
  idempotencyKey: string
  requestFingerprint: string
  createdAt: string
  idempotencyExpiresAt: string
}

export interface MediaArtifactLifecycleTransitionResult {
  transition: Readonly<MediaArtifactLifecycleTransitionRecord>
  replayed: boolean
}

export interface MediaArtifactLifecycleRepository {
  transitionOrReplay(
    bundle: MediaArtifactLifecycleTransitionBundle,
  ): Promise<MediaArtifactLifecycleTransitionResult>
}
