import type { EditCommand } from '../../domain/edit-command.ts'
import type {
  PersistedManualEditPayload,
  TimelineViewModel,
} from '../../domain/manual-editing.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export interface ManualEditVersionRecord {
  version: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  editPlanHash: string
}

export interface ManualEditContext extends ManualEditVersionRecord {
  availableAssetIds: readonly string[]
  targetVersion?: Readonly<ManualEditVersionRecord>
  history: readonly Readonly<{
    id: string
    sequence: number
    parentVersionId?: string
    commandId?: string
    commandType?: string
    action?: 'apply' | 'undo' | 'redo' | 'restore'
    restoresVersionId?: string
    createdAt: string
  }>[]
}

export interface ManualEditResult {
  command: Readonly<EditCommand<PersistedManualEditPayload>>
  version: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  timeline: Readonly<TimelineViewModel>
  comparison: Readonly<{
    beforeVersionId: string
    afterVersionId: string
    beforeEditPlanHash: string
    afterEditPlanHash: string
    action: 'apply' | 'undo' | 'redo' | 'restore'
    targetId: string
  }>
  replayed: boolean
}

export interface ManualEditCommit {
  command: Readonly<EditCommand<PersistedManualEditPayload>>
  requestFingerprint: string
  snapshot: Readonly<ProjectSnapshot>
  version: Readonly<ProjectVersion>
  event: Readonly<PublicEvent>
  comparison: ManualEditResult['comparison']
}

export interface ManualEditRepository {
  findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<{ requestFingerprint: string; result: ManualEditResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
    targetVersionId?: string
  }): Promise<Readonly<ManualEditContext> | null>
  commitOrReplay(bundle: ManualEditCommit): Promise<ManualEditResult>
}
