import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectLutSelection, ProjectLutSelectionRequest } from '../../domain/project-lut-selection.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
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
  currentVersion: Readonly<ProjectVersion>
  workspaceDefaultRevision?: number
  resolvedLutVersion?: Readonly<WorkspaceLutVersion>
  currentDurationFrames: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}
export interface ProjectLutSelectionResult {
  command: Readonly<EditCommand<ProjectLutSelectionCommandPayloadV2>>
  version: Readonly<ProjectVersion>
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
  command: Readonly<EditCommand<ProjectLutSelectionCommandPayloadV2>>
  version: Readonly<ProjectVersion>
  selection: Readonly<ProjectLutSelection>
  requestFingerprint: string
  event: Readonly<PublicEvent>
}
export interface ProjectLutSelectionRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<Readonly<{ requestFingerprint: string; result: Readonly<ProjectLutSelectionResult> }> | null>
  readContext(input: { workspaceId: string; projectId: string; requested: ProjectLutSelectionRequest }): Promise<Readonly<ProjectLutSelectionContext> | null>
  commitOrReplay(input: Readonly<ProjectLutSelectionCommit>): Promise<Readonly<ProjectLutSelectionResult>>
  readCurrent(input: { workspaceId: string; projectId: string }): Promise<Readonly<ProjectLutSelectionResult> | null>
  readEffectiveForVersion(input: { workspaceId: string; projectId: string; projectVersionId: string }): Promise<Readonly<EffectiveProjectLutSelection> | null>
}
