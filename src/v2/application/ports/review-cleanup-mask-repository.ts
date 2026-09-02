import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ReviewCleanupMask } from '../../domain/review-cleanup-mask.ts'

export interface PersistedReviewCleanupMask {
  mask: Readonly<ReviewCleanupMask>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  idempotencyKey: string
  requestFingerprint: string
}

export interface ReviewCleanupMaskRepository {
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedReviewCleanupMask> | null>
  read(input: {
    workspaceId: string
    projectId: string
    maskId: string
  }): Promise<Readonly<PersistedReviewCleanupMask> | null>
  readLatest(input: {
    workspaceId: string
    projectId: string
    rootId: string
  }): Promise<Readonly<PersistedReviewCleanupMask> | null>
  list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit: number
  }): Promise<readonly Readonly<PersistedReviewCleanupMask>[]>
  persist(input: {
    mask: Readonly<ReviewCleanupMask>
    authenticationAudit: Readonly<ApiAccessAuditContext>
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<Readonly<PersistedReviewCleanupMask>>
}
