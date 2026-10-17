import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectLutSelection, ProjectLutSelectionRequest } from '../../domain/project-lut-selection.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { WorkspaceLutVersion } from '../../domain/workspace-lut.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { ProjectLutSelectionImpactV1 } from '../../domain/project-lut-selection-impact.ts'

export type ProjectLutSelectionCommandPayloadV2 = ProjectLutSelectionRequest & Readonly<{
  schemaVersion: 2
  intensity: number
  impact: Readonly<ProjectLutSelectionImpactV1>
}>

export interface ProjectLutSelectionContext {
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
  workspaceDefaultRevision?: number
  resolvedLutVersion?: Readonly<WorkspaceLutVersion>
  currentDurationFrames: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}
export interface ProjectLutSelectionResult {
  command: Readonly<EditCommand<ProjectLutSelectionCommandPayloadV2>>
  version: Readonly<ProjectVersionV3>
  selection: Readonly<ProjectLutSelection>
  impact: Readonly<ProjectLutSelectionImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}
export interface EffectiveProjectLutSelection {
  selection: Readonly<ProjectLutSelection>
  resolvedLutVersion?: Readonly<WorkspaceLutVersion>
}
export interface ProjectLutSelectionCommit {
  /** Version, State, EditPlan, Command and credential audit, sealed together by the child-command transition. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  selection: Readonly<ProjectLutSelection>
  event: Readonly<PublicEvent>
}
export interface ProjectLutSelectionRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<Readonly<{ requestFingerprint: string; result: Readonly<ProjectLutSelectionResult> }> | null>
  readContext(input: { workspaceId: string; projectId: string; requested: ProjectLutSelectionRequest }): Promise<Readonly<ProjectLutSelectionContext> | null>
  commitOrReplay(input: Readonly<ProjectLutSelectionCommit>): Promise<Readonly<ProjectLutSelectionResult>>
  readCurrent(input: { workspaceId: string; projectId: string }): Promise<Readonly<ProjectLutSelectionResult> | null>
  readEffectiveForVersion(input: { workspaceId: string; projectId: string; projectVersionId: string }): Promise<Readonly<EffectiveProjectLutSelection> | null>
}
