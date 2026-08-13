import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { PerceptionTimeline } from '../../domain/perception-timeline.ts'

export interface PersistedPerceptionTimeline {
  schemaVersion: 'persisted-perception-timeline/v1'
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  baseRevision: string | null
  timeline: Readonly<PerceptionTimeline>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
  createdByClientId: string
  createdAt: string
  recordHash: string
}

export interface PerceptionTimelineRepository {
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<PersistedPerceptionTimeline> | null>
  findLatest(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<PersistedPerceptionTimeline> | null>
  persist(input: Readonly<PersistedPerceptionTimeline>): Promise<Readonly<{
    timeline: Readonly<PersistedPerceptionTimeline>
    replayed: boolean
  }>>
}
