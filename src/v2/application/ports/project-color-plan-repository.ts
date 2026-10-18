import type { ColorMetadata, ColorPlan, ColorPlanTarget } from '../../domain/color-and-export.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectColorPlan } from '../../domain/project-color-plan.ts'
import type { ProjectColorPlanImpactV1 } from '../../domain/project-color-plan-impact.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export type ProjectColorPlanCommandPayloadV1 = Readonly<{
  schemaVersion: 1
  colorPlanId: string
  colorPlanHash: string
  compiledManifestHash: string
  impact: Readonly<ProjectColorPlanImpactV1>
}>

export interface ProjectColorPlanContext {
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
  targets: readonly Readonly<ColorPlanTarget>[]
  trustedSourceMetadata: Readonly<Record<string, Readonly<ColorMetadata>>>
  currentDurationFrames: number
  /** Every output of the project: the stable variant ids of the sealed State the Command's child Version carries. */
  variantIds: readonly string[]
  /** The renders of the head Version, each attributed to its own output. */
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}

export interface ProjectColorPlanResult {
  command: Readonly<EditCommand<ProjectColorPlanCommandPayloadV1>>
  version: Readonly<ProjectVersionV3>
  colorPlan: Readonly<ProjectColorPlan>
  impact: Readonly<ProjectColorPlanImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface ProjectColorPlanCommit {
  /** Version, State, EditPlan, Command and credential audit, sealed together by the child-command transition. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  colorPlan: Readonly<ProjectColorPlan>
  event: Readonly<PublicEvent>
}

export interface ProjectColorPlanRepository {
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<{
    requestFingerprint: string
    result: Readonly<ProjectColorPlanResult>
  }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<ProjectColorPlanContext> | null>
  commitOrReplay(input: Readonly<ProjectColorPlanCommit>): Promise<Readonly<ProjectColorPlanResult>>
  readCurrent(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<ProjectColorPlanResult> | null>
  readEffectiveForVersion(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
  }): Promise<Readonly<ProjectColorPlan> | null>
}

export interface SetProjectColorPlanRequest {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  plan: Readonly<ColorPlan>
  reason?: string
  idempotencyKey: string
}
