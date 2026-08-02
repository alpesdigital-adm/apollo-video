import type {
  PostCleanupReview,
  SourceCleanupPlan,
} from '../../domain/source-cleanup.ts'
import type { PublicOperation } from '../../domain/public-operation.ts'
import type {
  SourceCleanupOperationContext,
} from './public-operation-repository.ts'

export interface SourceCleanupRecord {
  plan: Readonly<SourceCleanupPlan>
  operation?: Readonly<PublicOperation>
  review?: Readonly<PostCleanupReview>
}

export interface SourceCleanupCreateRecord {
  plan: Readonly<SourceCleanupPlan>
  operation?: Readonly<PublicOperation>
  operationContext?: Readonly<SourceCleanupOperationContext>
  requestFingerprint: string
  idempotencyKey: string
  traceId?: string
}

export interface SourceCleanupReplay {
  record: Readonly<SourceCleanupRecord>
  requestFingerprint: string
}

export interface SourceCleanupPage {
  cleanups: readonly Readonly<SourceCleanupRecord>[]
  nextCursor?: string
}

export interface SourceCleanupRepository {
  findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<SourceCleanupReplay> | null>
  create(
    record: Readonly<SourceCleanupCreateRecord>,
  ): Promise<Readonly<SourceCleanupRecord & { replayed: boolean }>>
  read(input: {
    workspaceId: string
    projectId: string
    cleanupPlanId: string
  }): Promise<Readonly<SourceCleanupRecord> | null>
  list(input: {
    workspaceId: string
    projectId: string
    contaminationReportId?: string
    findingId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<SourceCleanupPage>>
  persistReview(input: {
    review: Readonly<PostCleanupReview>
  }): Promise<Readonly<SourceCleanupRecord>>
}
