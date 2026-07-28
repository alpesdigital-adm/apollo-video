import type {
  BatchEditCommand,
  BatchEditItemContext,
  BatchEditItemState,
  BatchEditPolicy,
  BatchEditPreflightRun,
} from '../../domain/batch-edit.ts'

export interface BatchEditPreflightRecord {
  run: Readonly<BatchEditPreflightRun>
  requestFingerprint: string
  idempotencyKey: string
}

export interface BatchEditCommandRecord {
  command: Readonly<BatchEditCommand>
  requestFingerprint: string
  idempotencyKey: string
}

export interface BatchEditPreflightReplay {
  run: Readonly<BatchEditPreflightRun>
  requestFingerprint: string
}

export interface BatchEditCommandReplay {
  command: Readonly<BatchEditCommand>
  requestFingerprint: string
}

export interface BatchEditPreflightPage {
  preflights: readonly Readonly<BatchEditPreflightRun>[]
  nextCursor?: string
}

export interface BatchEditCommandPage {
  commands: readonly Readonly<BatchEditCommand>[]
  nextCursor?: string
}

export interface BatchEditRepository {
  loadPreflightContext(input: {
    workspaceId: string
    batchId: string
    expectedBatchRevision: number
    expectedBatchDefinitionHash: string
    itemIds: readonly string[]
    actorClientId: string
    createdAt: string
  }): Promise<Readonly<{
    projectId: string
    batchRevision: number
    batchDefinitionHash: string
    availableRecipeIds: readonly string[]
    availableOutputSpecIds: readonly string[]
    availableItemIds: readonly string[]
    items: readonly Readonly<BatchEditItemContext>[]
    budgetRemainingMinorUnits: number
  }>>
  loadCommitStates(input: {
    workspaceId: string
    batchId: string
    itemIds: readonly string[]
  }): Promise<readonly Readonly<BatchEditItemState>[]>
  readPolicy(input: {
    workspaceId: string
  }): Promise<Readonly<BatchEditPolicy> | null>
  ensurePolicy(
    policy: Readonly<BatchEditPolicy>,
  ): Promise<Readonly<BatchEditPolicy>>
  findPreflightReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<BatchEditPreflightReplay> | null>
  createPreflight(
    record: Readonly<BatchEditPreflightRecord>,
  ): Promise<Readonly<{
    run: Readonly<BatchEditPreflightRun>
    replayed: boolean
  }>>
  readPreflightRecord(input: {
    workspaceId: string
    batchId: string
    preflightId: string
  }): Promise<Readonly<BatchEditPreflightRecord> | null>
  listPreflights(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<BatchEditPreflightPage>>
  findCommandReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<BatchEditCommandReplay> | null>
  commit(
    record: Readonly<BatchEditCommandRecord>,
  ): Promise<Readonly<{
    command: Readonly<BatchEditCommand>
    replayed: boolean
  }>>
  readCommand(input: {
    workspaceId: string
    batchId: string
    commandId: string
  }): Promise<Readonly<BatchEditCommand> | null>
  listCommands(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<BatchEditCommandPage>>
}
