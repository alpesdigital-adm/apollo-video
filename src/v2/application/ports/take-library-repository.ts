import type { ScriptAlignmentRun } from '../../domain/script-alignment.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type {
  TakeLibraryRun,
  TakeLibrarySelection,
} from '../../domain/take-library.ts'

export interface TakeLibraryCreateRecord {
  run: Readonly<TakeLibraryRun>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface TakeLibrarySelectionRecord {
  previousRun: Readonly<TakeLibraryRun>
  resultingRun: Readonly<TakeLibraryRun>
  selection: Readonly<TakeLibrarySelection>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface TakeLibraryReplay {
  run: Readonly<TakeLibraryRun>
  requestFingerprint: string
}

export interface TakeLibraryPage {
  runs: readonly Readonly<TakeLibraryRun>[]
  nextCursor?: string
}

export interface TakeLibraryRepository {
  loadCreationContext(input: {
    workspaceId: string
    batchId: string
    alignmentId: string
    expectedAlignmentRunHash: string
    actorClientId: string
  }): Promise<Readonly<{
    projectId: string
    alignment: Readonly<ScriptAlignmentRun>
  }>>
  findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<TakeLibraryReplay> | null>
  create(
    record: Readonly<TakeLibraryCreateRecord>,
  ): Promise<Readonly<{
    run: Readonly<TakeLibraryRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<TakeLibraryRun> | null>
  list(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<TakeLibraryPage>>
  findSelectionReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<TakeLibraryReplay> | null>
  persistSelection(
    record: Readonly<TakeLibrarySelectionRecord>,
  ): Promise<Readonly<{
    run: Readonly<TakeLibraryRun>
    replayed: boolean
  }>>
}
