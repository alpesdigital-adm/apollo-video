import type { CommandImpactOutputReference, CommandImpactV1 } from '../../domain/command-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
import type { VariantReframeOverrideAction, VariantReframeOverrideV2 } from '../../domain/variant-reframe-overrides.ts'
import type { VariantReframePlanRecordV1 } from '../../domain/variant-reframe-plan.ts'
import type { StoredVariantReframePlan, VariantReframePlanContext } from './variant-reframe-plan-repository.ts'

export interface VariantReframeOverrideContext {
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
  durationFrames: number
  /** The head Version's facts for the target variant (sealed spec, timeline, source, clips, current override heads). */
  plan: Readonly<VariantReframePlanContext>
  /** The latest plan record of the target variant at the head Version, or null when no plan was requested yet. */
  currentPlan: Readonly<StoredVariantReframePlan> | null
  /** The latest plan record of every OTHER output at the head Version: each is carried unchanged to the result Version. */
  siblingPlans: readonly Readonly<StoredVariantReframePlan>[]
  /** The renders of the head Version, each attributed to the stable State variant it was made for. */
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
  /** Head override of the exact (variant, clip, range), or null. */
  currentOverride: Readonly<VariantReframeOverrideV2> | null
}

export interface VariantReframeOverridePayload {
  schemaVersion: 1
  variantId: string
  clipId: string
  range: Readonly<{ startFrame: number; endFrame: number }>
  action: VariantReframeOverrideAction
  crop: Readonly<{ x: number; y: number; width: number; height: number }> | null
  impact: CommandImpactV1
}

export interface VariantReframeOverrideResult {
  command: Readonly<EditCommand<VariantReframeOverridePayload>>
  version: Readonly<ProjectVersionV3>
  reframeOverride: Readonly<VariantReframeOverrideV2>
  /** The plan record the result Version carries for the target variant. */
  plan: Readonly<StoredVariantReframePlan>
  impact: Readonly<CommandImpactV1>
  replayed: boolean
}

export interface VariantReframeOverrideRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<
    Readonly<{ requestFingerprint: string; result: VariantReframeOverrideResult }> | null
  >
  readContext(input: {
    workspaceId: string
    projectId: string
    variantId: string
    clipId: string
    startFrame: number
    endFrame: number
  }): Promise<Readonly<VariantReframeOverrideContext> | null>
  commitOrReplay(input: {
    /** The bundle carries the Version, State, EditPlan, Command and credential audit, sealed together. */
    bundle: Readonly<OperationalOutputVersionBundleV3>
    reframeOverride: Readonly<VariantReframeOverrideV2>
    impact: Readonly<CommandImpactV1>
    /** The plan records of the result Version: the target variant's, re-decided with the override on top of the SAME observations, and the siblings', carried. */
    plans: readonly Readonly<{ variantId: string; record: Readonly<VariantReframePlanRecordV1> }>[]
  }): Promise<Readonly<VariantReframeOverrideResult>>
  /** Every head override of one variant. */
  listCurrentByVariant(input: { workspaceId: string; projectId: string; variantId: string }): Promise<readonly Readonly<VariantReframeOverrideV2>[]>
}
