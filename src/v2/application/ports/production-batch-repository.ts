import type {
  BatchPartialRetryRun,
} from '../../domain/batch-partial-retry.ts'
import type {
  BatchItemAction,
  BatchItem,
  ProductionBatch,
  ProductionBatchEditorialRequest,
  ProductionBatchStatus,
  ProductionBatchStep,
} from '../../domain/production-batch.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface ProductionBatchCreateRecord {
  batch: Readonly<ProductionBatch>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface ProductionBatchActionRecord {
  id: string
  workspaceId: string
  batchId: string
  itemId?: string
  scope: 'batch' | 'item'
  action: BatchItemAction | 'cancel' | 'resume' | 'partial-retry'
  step?: ProductionBatchStep
  expectedBatchRevision: number
  expectedItemRevision?: number
  requestFingerprint: string
  idempotencyKey: string
  actorClientId: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
  createdAt: string
  resultingBatch: Readonly<ProductionBatch>
  partialRetry?: Readonly<BatchPartialRetryRun>
}

/** One later request of a batch (the batch document itself never changes): append-only, the highest `sequence` is the current request. */
export interface ProductionBatchRequestRevision {
  id: string
  workspaceId: string
  batchId: string
  sequence: number
  /** Null when the batch had no request before this one. */
  previousRequestHash: string | null
  editorialRequest: Readonly<ProductionBatchEditorialRequest>
  /** What this revision changed (the briefing, the questions answered, whether the briefing was read again). */
  change: Readonly<Record<string, unknown>>
  createdAt: string
}

export interface ProductionBatchRequestRevisionRecord extends Readonly<ProductionBatchRequestRevision> {
  requestFingerprint: string
  idempotencyKey: string
  actorClientId: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface ProductionBatchRequestRevisionReplay {
  revision: Readonly<ProductionBatchRequestRevision>
  requestFingerprint: string
}

export interface ProductionBatchReplay {
  batch: Readonly<ProductionBatch>
  requestFingerprint: string
}

export interface ProductionBatchPartialRetryReplay
extends ProductionBatchReplay {
  partialRetry: Readonly<BatchPartialRetryRun>
}

export interface ProductionBatchPartialRetryPage {
  retries: readonly Readonly<BatchPartialRetryRun>[]
  nextCursor?: string
}

export interface ProductionBatchPage {
  batches: readonly Readonly<ProductionBatch>[]
  nextCursor?: string
}

export interface ProductionBatchItemOperationRecord {
  batch: Readonly<ProductionBatch>
  item: Readonly<BatchItem>
}

export interface ProductionBatchRepository {
  findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchReplay> | null>
  create(
    record: Readonly<ProductionBatchCreateRecord>,
  ): Promise<Readonly<{
    batch: Readonly<ProductionBatch>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    batchId: string
  }): Promise<Readonly<ProductionBatch> | null>
  findItemOperation(input: {
    workspaceId: string
    operationId: string
  }): Promise<Readonly<ProductionBatchItemOperationRecord> | null>
  list(input: {
    workspaceId: string
    projectId?: string
    status?: ProductionBatchStatus
    query?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ProductionBatchPage>>
  findActionReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchReplay> | null>
  findPartialRetryReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchPartialRetryReplay> | null>
  readPartialRetry(input: {
    workspaceId: string
    batchId: string
    retryId: string
  }): Promise<Readonly<BatchPartialRetryRun> | null>
  listPartialRetries(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ProductionBatchPartialRetryPage>>
  /** The latest revision of the request of a batch; null when the request it was created with is still the current one. */
  readCurrentEditorialRequest(input: {
    workspaceId: string
    batchId: string
  }): Promise<Readonly<ProductionBatchRequestRevision> | null>
  findRequestRevisionReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchRequestRevisionReplay> | null>
  persistRequestRevision(
    record: Readonly<ProductionBatchRequestRevisionRecord>,
  ): Promise<Readonly<{ revision: Readonly<ProductionBatchRequestRevision>; replayed: boolean }>>
  persistAction(
    record: Readonly<ProductionBatchActionRecord>,
  ): Promise<Readonly<{
    batch: Readonly<ProductionBatch>
    replayed: boolean
    partialRetry?: Readonly<BatchPartialRetryRun>
  }>>
}
