import type { EditCommand } from '../../domain/edit-command.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type {
  ProjectSubtitleConfiguration,
  ProjectSubtitleConfigurationAction,
  ProjectSubtitleConfigurationImpactV1,
} from '../../domain/project-subtitle-configuration.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
import type { SubtitleModeRequest, SubtitlePresetId } from '../../domain/subtitle-system.ts'

export interface ProjectSubtitleConfigurationContext {
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
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
  version: Readonly<ProjectVersionV3>
  configuration: Readonly<ProjectSubtitleConfiguration>
  impact: Readonly<ProjectSubtitleConfigurationImpactV1>
  replayed: boolean
}
export interface ProjectSubtitleConfigurationRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<Readonly<{ requestFingerprint: string; result: ProjectSubtitleConfigurationResult }> | null>
  readContext(input: { workspaceId: string; projectId: string; variantId: string; requested?: SubtitleModeRequest }): Promise<Readonly<ProjectSubtitleConfigurationContext> | null>
  /** The bundle carries the Version, State, EditPlan, Command and credential audit, sealed together. */
  commitOrReplay(input: { bundle: Readonly<OperationalOutputVersionBundleV3>; configuration: Readonly<ProjectSubtitleConfiguration>; impact: Readonly<ProjectSubtitleConfigurationImpactV1> }): Promise<Readonly<ProjectSubtitleConfigurationResult>>
  readCurrent(input: { workspaceId: string; projectId: string; variantId: string }): Promise<Readonly<ProjectSubtitleConfigurationResult> | null>
}
