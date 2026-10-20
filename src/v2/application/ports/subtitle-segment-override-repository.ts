import type { CommandImpactOutputReference, CommandImpactV1 } from '../../domain/command-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
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
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
  durationFrames: number
  /** Compiled segments of the target variant. An override may only name one of these. */
  segments: readonly Readonly<SubtitleSegmentOverrideCompiledSegment>[]
  /**
   * The renders of the head Version, each attributed to the stable State variant it was made for (`renderOutputReferences`). The
   * service keeps the target variant's only: the other outputs' renders stay valid.
   */
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
  /** Head override of this (variant, segment), or null while the segment is inherited. */
  currentOverride: Readonly<SubtitleSegmentOverride> | null
  /** Override the head replaced — the level a `reset` returns to. */
  previousOverride: Readonly<SubtitleSegmentOverride> | null
}

/** The segments of one output of the head Version, with every head exception of that output (W68: what the editor lists). */
export interface SubtitleSegmentsView {
  version: Readonly<{ id: string; sequence: number; baseHash: string }>
  variantId: string
  fps: number
  durationFrames: number
  segments: readonly Readonly<SubtitleSegmentOverrideCompiledSegment>[]
  overrides: readonly Readonly<SubtitleSegmentOverride>[]
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
  version: Readonly<ProjectVersionV3>
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
    /** The bundle carries the Version, State, EditPlan, Command and credential audit, sealed together. */
    bundle: Readonly<OperationalOutputVersionBundleV3>
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
   * The compiled segments of one output of the CURRENT Version and its head exceptions. The project must exist in this workspace and the
   * variant must be an exact member of the sealed State of the head (an aspect ratio is not one), or the read is refused.
   */
  readSegments(input: { workspaceId: string; projectId: string; variantId: string }): Promise<Readonly<SubtitleSegmentsView> | null>
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
