import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ColorMetadata, ColorPlan, ColorPlanTarget } from '../../domain/color-and-export.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectColorPlan } from '../../domain/project-color-plan.ts'
import type { ProjectColorPlanImpactV1 } from '../../domain/project-color-plan-impact.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export type ProjectColorPlanCommandPayloadV1 = Readonly<{
  schemaVersion: 1
  colorPlanId: string
  colorPlanHash: string
  compiledManifestHash: string
  impact: Readonly<ProjectColorPlanImpactV1>
}>

export interface ProjectColorPlanContext {
  currentVersion: Readonly<ProjectVersion>
  targets: readonly Readonly<ColorPlanTarget>[]
  trustedSourceMetadata: Readonly<Record<string, Readonly<ColorMetadata>>>
  currentDurationFrames: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}

export interface ProjectColorPlanResult {
  command: Readonly<EditCommand<ProjectColorPlanCommandPayloadV1>>
  version: Readonly<ProjectVersion>
  colorPlan: Readonly<ProjectColorPlan>
  impact: Readonly<ProjectColorPlanImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface ProjectColorPlanCommit {
  command: Readonly<EditCommand<ProjectColorPlanCommandPayloadV1>>
  authenticationAudit?: Readonly<ApiAccessAuditContext>
  version: Readonly<ProjectVersion>
  colorPlan: Readonly<ProjectColorPlan>
  requestFingerprint: string
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
