import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { CommandImpactOutputReference, CommandImpactV1 } from '../../domain/command-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type {
  SubtitleSegmentOverride,
  SubtitleSegmentOverrideAction,
  SubtitleSegmentOverrideDimension,
} from '../../domain/subtitle-segment-override.ts'

/** One compiled subtitle segment of the current EditPlan, as the adapter reads it. */
export interface SubtitleSegmentOverrideCompiledSegment {
  id: string
  startFrame: number
  /** Exclusive. */
  endFrame: number
  text: string
}

export interface SubtitleSegmentOverrideContext {
  currentVersion: Readonly<ProjectVersion>
  durationFrames: number
  /** Compiled segments of the target variant. An override may only name one of these. */
  segments: readonly Readonly<SubtitleSegmentOverrideCompiledSegment>[]
  /** Output variants the current EditPlan actually compiles. */
  variantIds: readonly string[]
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
  /** Head override of this (variant, segment), or null while the segment is inherited. */
  currentOverride: Readonly<SubtitleSegmentOverride> | null
  /** Override the head replaced — the level a `reset` returns to. */
  previousOverride: Readonly<SubtitleSegmentOverride> | null
}

export interface SubtitleSegmentOverridePayload {
  schemaVersion: 1
  variantId: string
  segmentId: string
  range: Readonly<{ startFrame: number; endFrame: number }>
  action: SubtitleSegmentOverrideAction
  dimensions: readonly SubtitleSegmentOverrideDimension[]
  protected: boolean
  impact: CommandImpactV1
}

export interface SubtitleSegmentOverrideResult {
  command: Readonly<EditCommand<SubtitleSegmentOverridePayload>>
  version: Readonly<ProjectVersion>
  subtitleOverride: Readonly<SubtitleSegmentOverride>
  impact: Readonly<CommandImpactV1>
  replayed: boolean
}

export interface SubtitleSegmentOverrideRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<
    Readonly<{ requestFingerprint: string; result: SubtitleSegmentOverrideResult }> | null
  >
  readContext(input: {
    workspaceId: string
    projectId: string
    variantId: string
    segmentId: string
  }): Promise<Readonly<SubtitleSegmentOverrideContext> | null>
  commitOrReplay(input: {
    requestFingerprint: string
    authenticationAudit?: Readonly<ApiAccessAuditContext>
    command: SubtitleSegmentOverrideResult['command']
    version: Readonly<ProjectVersion>
    subtitleOverride: Readonly<SubtitleSegmentOverride>
    impact: Readonly<CommandImpactV1>
  }): Promise<Readonly<SubtitleSegmentOverrideResult>>
  /** Head override of one segment, or null while it is inherited. */
  readCurrent(input: {
    workspaceId: string
    projectId: string
    variantId: string
    segmentId: string
  }): Promise<Readonly<SubtitleSegmentOverrideResult> | null>
  /**
   * Every head override of one variant — what the compiler applies to the cues it
   * produced. Scoped by workspace, project and variant, so a variant never reads
   * another variant's exceptions.
   */
  listCurrentByVariant(input: {
    workspaceId: string
    projectId: string
    variantId: string
  }): Promise<readonly Readonly<SubtitleSegmentOverride>[]>
}
