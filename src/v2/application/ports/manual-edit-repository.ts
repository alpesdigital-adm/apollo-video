import type { EditCommand } from '../../domain/edit-command.ts'
import type {
  PersistedManualEditPayload,
  TimelineViewModel,
} from '../../domain/manual-editing.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type {
  CommandArtifactInvalidationV1,
  CommandImpactOutputReference,
  CommandImpactV1,
} from '../../domain/command-impact.ts'

export interface ManualEditVersionRecord {
  version: Readonly<ProjectVersionV2 | ProjectVersionV3>
  editPlan: Readonly<Record<string, unknown>>
  editPlanHash: string
  /** The sealed output bundle behind this Version: the exact parent (or restore target) a manual edit is born from. */
  bundle: OperationalOutputParentV3
}

export interface ManualEditContext extends ManualEditVersionRecord {
  availableAssetIds: readonly string[]
  renderVariantIds: readonly string[]
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
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
  version: Readonly<ProjectVersionV3>
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
  impact?: Readonly<CommandImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
}

export interface ManualEditCommit {
  /** Version, State, EditPlan, Command and credential audit, sealed together by the manual-edit transition. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  event: Readonly<PublicEvent>
  comparison: ManualEditResult['comparison']
  impact: Readonly<CommandImpactV1>
}

export interface ManualEditInvalidationView {
  projectId: string
  resultVersionId: string
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
}

export interface ManualEditRepository {
  findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<{ requestFingerprint: string; result: ManualEditResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
    targetVersionId?: string
  }): Promise<Readonly<ManualEditContext> | null>
  readArtifactInvalidations(input: {
    workspaceId: string
    projectId: string
    resultVersionId?: string
  }): Promise<Readonly<ManualEditInvalidationView> | null>
  commitOrReplay(bundle: ManualEditCommit): Promise<ManualEditResult>
}
