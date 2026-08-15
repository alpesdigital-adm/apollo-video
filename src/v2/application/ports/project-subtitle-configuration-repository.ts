import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type {
  ProjectSubtitleConfiguration,
  ProjectSubtitleConfigurationAction,
  ProjectSubtitleConfigurationImpactV1,
} from '../../domain/project-subtitle-configuration.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { SubtitleModeRequest, SubtitlePresetId } from '../../domain/subtitle-system.ts'

export interface ProjectSubtitleConfigurationContext {
  currentVersion: Readonly<ProjectVersion>
  transcript: unknown
  directorPresetId: SubtitlePresetId
  workspaceDefault?: Readonly<{ presetId: SubtitlePresetId; revision: number }>
  durationFrames: number
  outputReferences: readonly Readonly<{ artifactId: string; kind: 'proxy' | 'final'; sourceVersionId: string; variantId: string }>[]
  /** Head configuration of this variant, or null while the variant is still inherited. */
  currentConfiguration: Readonly<ProjectSubtitleConfiguration> | null
  /** Configuration the head replaced — the target a `revert` returns to. */
  previousConfiguration: Readonly<ProjectSubtitleConfiguration> | null
}
export interface ProjectSubtitleConfigurationResult {
  command: Readonly<EditCommand<{ schemaVersion: 1; variantId: string; action: ProjectSubtitleConfigurationAction; requested: SubtitleModeRequest; impact: ProjectSubtitleConfigurationImpactV1 }>>
  version: Readonly<ProjectVersion>
  configuration: Readonly<ProjectSubtitleConfiguration>
  impact: Readonly<ProjectSubtitleConfigurationImpactV1>
  replayed: boolean
}
export interface ProjectSubtitleConfigurationRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<Readonly<{ requestFingerprint: string; result: ProjectSubtitleConfigurationResult }> | null>
  readContext(input: { workspaceId: string; projectId: string; variantId: string; requested?: SubtitleModeRequest }): Promise<Readonly<ProjectSubtitleConfigurationContext> | null>
  commitOrReplay(input: { requestFingerprint: string; authenticationAudit?: Readonly<ApiAccessAuditContext>; command: ProjectSubtitleConfigurationResult['command']; version: Readonly<ProjectVersion>; configuration: Readonly<ProjectSubtitleConfiguration>; impact: Readonly<ProjectSubtitleConfigurationImpactV1> }): Promise<Readonly<ProjectSubtitleConfigurationResult>>
  readCurrent(input: { workspaceId: string; projectId: string; variantId: string }): Promise<Readonly<ProjectSubtitleConfigurationResult> | null>
}
