import type {
  BatchItemAction,
  ProductionBatch,
  ProductionBatchStatus,
  ProductionBatchStep,
} from '../../domain/production-batch.ts'

export interface ProductionBatchCreateRecord {
  batch: Readonly<ProductionBatch>
  requestFingerprint: string
  idempotencyKey: string
}

export interface ProductionBatchActionRecord {
  id: string
  workspaceId: string
  batchId: string
  itemId?: string
  scope: 'batch' | 'item'
  action: BatchItemAction | 'cancel' | 'resume'
  step?: ProductionBatchStep
  expectedBatchRevision: number
  expectedItemRevision?: number
  requestFingerprint: string
  idempotencyKey: string
  actorClientId: string
  createdAt: string
  resultingBatch: Readonly<ProductionBatch>
}

export interface ProductionBatchReplay {
  batch: Readonly<ProductionBatch>
  requestFingerprint: string
}

export interface ProductionBatchPage {
  batches: readonly Readonly<ProductionBatch>[]
  nextCursor?: string
}

export interface ProductionBatchRepository {
  findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
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
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchReplay> | null>
  persistAction(
    record: Readonly<ProductionBatchActionRecord>,
  ): Promise<Readonly<{
    batch: Readonly<ProductionBatch>
    replayed: boolean
  }>>
}
