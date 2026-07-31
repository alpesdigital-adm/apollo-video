import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectLutSelection, ProjectLutSelectionRequest } from '../../domain/project-lut-selection.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { WorkspaceLutVersion } from '../../domain/workspace-lut.ts'

export interface ProjectLutSelectionContext {
  currentVersion: Readonly<ProjectVersion>
  workspaceDefaultRevision?: number
  resolvedLutVersion?: Readonly<WorkspaceLutVersion>
}
export interface ProjectLutSelectionResult {
  command: Readonly<EditCommand<ProjectLutSelectionRequest & { intensity: number }>>
  version: Readonly<ProjectVersion>
  selection: Readonly<ProjectLutSelection>
  replayed: boolean
}
export interface EffectiveProjectLutSelection {
  selection: Readonly<ProjectLutSelection>
  resolvedLutVersion?: Readonly<WorkspaceLutVersion>
}
export interface ProjectLutSelectionCommit {
  command: Readonly<EditCommand<ProjectLutSelectionRequest & { intensity: number }>>
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
