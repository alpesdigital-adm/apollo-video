import type {
  CompatibilityGraphRun,
} from '../../domain/compatibility-graph.ts'
import type { TakeLibraryRun } from '../../domain/take-library.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface CompatibilityGraphCreateRecord {
  run: Readonly<CompatibilityGraphRun>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface CompatibilityGraphReplay {
  run: Readonly<CompatibilityGraphRun>
  requestFingerprint: string
}

export interface CompatibilityGraphPage {
  runs: readonly Readonly<CompatibilityGraphRun>[]
  nextCursor?: string
}

export interface CompatibilityGraphRepository {
  loadCreationContext(input: {
    workspaceId: string
    batchId: string
    takeLibraryId: string
    expectedTakeLibraryRunHash: string
    actorClientId: string
  }): Promise<Readonly<{
    projectId: string
    takeLibrary: Readonly<TakeLibraryRun>
  }>>
  findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<CompatibilityGraphReplay> | null>
  create(
    record: Readonly<CompatibilityGraphCreateRecord>,
  ): Promise<Readonly<{
    run: Readonly<CompatibilityGraphRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<CompatibilityGraphRun> | null>
  list(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<CompatibilityGraphPage>>
}
