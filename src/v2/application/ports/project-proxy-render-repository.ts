import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { EditorialPolicyResolutionV1 } from '../../domain/editorial-policy-resolution.ts'
import type { FormatSubjectEvidenceV1 } from '../../domain/format-quality-critic.ts'
import type { DirectorRunInheritance } from '../../domain/director-run-inheritance.ts'
import type { RenderColorGradeV1 } from '../../domain/render-color-grade.ts'
import type { OutputConsumptionSealV3 } from '../../domain/output-consumption.ts'
import type { PerceptionTimeline } from '../../domain/perception-timeline.ts'
import type { RenderReframePlanV1 } from '../../domain/render-reframe-plan.ts'
import type { VariantReframeIssueV1 } from '../../domain/variant-reframe-plan.ts'
import type { SubtitlePresetId, SubtitlePresetSnapshot } from '../../domain/subtitle-system.ts'
import type { SubtitleSegmentOverride } from '../../domain/subtitle-segment-override.ts'
import type { ProxyQualityIssue, ProxyReview } from '../render-workflow.ts'

/**
 * Upper bound on how many disjoint stale ranges a single partial proxy render may
 * stitch. Above it the repository falls back to a full render and the renderer
 * fails closed, because each extra range costs one more encode plus two more
 * concat seams.
 */
export const MAX_PARTIAL_RENDER_RANGES = 8

export interface ProjectProxyRangeReuse {
  schemaVersion: 'project-proxy-range-reuse/v1'
  commandId: string
  impactHash: string
  baseVersionId: string
  ranges: readonly Readonly<{ startFrame: number; endFrame: number }>[]
  artifactId: string
  manifestId: string
  artifactKey: string
  sha256: string
  byteSize: number
}

export interface ProjectProxyUnchangedReuse {
  schemaVersion: 'project-proxy-unchanged-reuse/v1'
  commandId: string
  impactHash: string
  baseVersionId: string
  operationId: string
  artifactId: string
  manifestId: string
  artifactKey: string
  sha256: string
  byteSize: number
}

export interface ProjectRenderSourceAsset {
  artifactId: string
  manifestId: string
  artifactKey: string
  sha256: string
  byteSize: number
  mediaType: 'video' | 'audio'
  container: string
  role: 'source-master' | 'selected-insert' | 'approved-music'
  /**
   * Observed dimensions of the stored video (its manifest probe). The caption planner projects the source frame onto the
   * variant's canvas with them; without them the projection is unavailable and every band is unknown. Deliberately NOT part
   * of `projectRenderSourcesFingerprint`: the enqueue identity of a render does not move because a probe became known.
   */
  probe?: Readonly<{ width: number; height: number }>
}

/**
 * What a render consumer may do with a Version: the proxy renders it (`render`), the final export publishes it (`final`). The
 * persisted consumption reader decides both; a consumer never completes the answer with the project's format or the head.
 */
export type ProjectRenderConsumptionPurpose = 'render' | 'final'

export interface ProjectProxyRenderSource {
  projectId: string
  projectVersionId: string
  editPlanSnapshotId: string
  editPlanHash: string
  editPlan: Readonly<EditorialCutEditPlan | DirectedEditPlan>
  /** The aspect ratio the sealed entry of the consumed State carries: the only authority for the format of this render. */
  format: string
  /**
   * The exact Version, State, variant revision and materialization this source was read from (the persisted consumption
   * verdict, sealed). Its hash is part of every input hash derived from this source, so an operation sealed to one State is
   * refused when the State, the variant revision or the materialization it consumes is another.
   */
  outputConsumption: Readonly<{ seal: Readonly<OutputConsumptionSealV3>; sealHash: string }>
  /** Present only after repository verification of sealed OCR, base/result lineage and identical time map. */
  trustedOcr?: Readonly<{
    envelopeId: string
    envelopeHash: string
    inputVersionId: string
    timeMapHash: string
    timeline: Readonly<PerceptionTimeline>
  }>
  sourceArtifactId: string
  sourceManifestId: string
  sourceArtifactKey: string
  sourceSha256: string
  renderSources: readonly Readonly<ProjectRenderSourceAsset>[]
  originalFileName: string
  uploadReceivedAt: string
  criticIssues: readonly Readonly<ProxyQualityIssue>[]
  /**
   * ADR-160. The sealed policy resolution of the DirectorRun whose plan this is (its own, or the ancestor's reached through exception Commands).
   * Absent for a plan no Director made (a cut of the source, a compile of an aggregate) and for a run born under an earlier resolution schema.
   * The render worker checks the plan against it (`assertPlanHonorsResolution`), and the render's identity names it.
   */
  policyResolution?: Readonly<EditorialPolicyResolutionV1>
  /**
   * W70 readiness. Present when `criticIssues` are the issues of a DirectorRun of an ANCESTOR Version, reached through exception Commands
   * only (a subtitle segment exception, a manual reframe): the Versions and Commands the Director's quality went through. Absent when the
   * Version is the Director's own (or has no Director run at all).
   */
  directorInheritance?: Readonly<DirectorRunInheritance>
  /**
   * W70 readiness (R2). The colour grade a render of this Version applies (effective ColorPlan and LUT selection, by ancestry), read with the
   * source. Part of the input hash and of the content address; the worker refuses to render when the grade it applies is another one. Absent
   * only on a source not read by the project render repository (a renderable snapshot), which then keeps the identity it always had.
   */
  colorGrade?: Readonly<RenderColorGradeV1>
  rangeReuse?: Readonly<ProjectProxyRangeReuse>
  unchangedReuse?: Readonly<ProjectProxyUnchangedReuse>
  unchangedReuseRequired?: true
  /**
   * Persisted subtitle resolution for this variant, when the project has one. It carries the
   * F1.033 `registryHash`, so the worker can bind the subtitle geometry of the placement plan to
   * the preset the Command actually recorded instead of guessing a default. When enabled it also
   * carries the content-addressed `presetSnapshot` (FR-172): the tokens themselves, so a render
   * recorded before a registry revision reproduces with the style it was recorded with.
   */
  subtitleResolution?: Readonly<{ presetId: SubtitlePresetId; presetHash: string; registryHash: string; enabled: boolean; presetSnapshot?: Readonly<SubtitlePresetSnapshot> }>
  /**
   * Crop trajectory materialized upstream. The worker never invents one: it forwards what was
   * persisted and fails closed when it does not describe this render.
   */
  reframePlan?: Readonly<RenderReframePlanV1>
  /**
   * W66r. The localized issues of the persisted reframe plan record this `reframePlan` came from (range, variant, evidence), and the record's
   * content address. They travel with the plan so the critic judges the very frames that plan produced, and so a render's identity moves when
   * the plan does. Absent exactly when no plan was persisted for this Version and output.
   */
  reframeIssues?: readonly Readonly<VariantReframeIssueV1>[]
  reframeRecordHash?: string
  /**
   * W68. The persisted per-segment subtitle exceptions (head of each segment) of THIS output, and the content address of the ones that
   * carry a value. They travel with the source so the render and its identity move when an exception does; a variant with none, or whose
   * every exception was reset, has neither (and keeps the identity it always had).
   */
  subtitleOverrides?: readonly Readonly<SubtitleSegmentOverride>[]
  subtitleOverridesHash?: string
  /**
   * Protected subject evidence already projected onto **this** variant's canvas, as perception
   * persisted it. Without it two of the five format reason codes — `SUBTITLE_SUBJECT_COLLISION`
   * and `SUBJECT_NOT_VISIBLE` — are unreachable from the runtime, because the critic only knows
   * about subjects the worker hands it. The worker forwards this list untouched; it never invents
   * or re-detects a subject.
   */
  formatSubjects?: readonly Readonly<FormatSubjectEvidenceV1>[]
  /** Drawable placement assets (logo/insert) already bound to the version, with their digests. */
  placementAssets?: readonly Readonly<{
    elementId: string
    artifactId: string
    artifactKey: string
    sha256: string
    byteSize: number
  }>[]
}

/** Captured from the repository-resolved render input; re-resolved at attachment. */
export interface ProjectProxyOcrReceipt {
  envelopeId: string
  envelopeHash: string
  inputVersionId: string
  timeMapHash: string
  timelineHash: string
  sourceArtifactId: string
  sourceManifestId: string
  sourceSha256: string
  editPlanHash: string
}

/**
 * W70 readiness (R2). The digests a completed render stores beside its content address (`proxy-render-evidence.ts`): the face windows its
 * caption placement read, with the pending ones, and the Director's quality issues its review is built over.
 */
export interface ProjectProxyRenderEvidence {
  faceEvidenceDigest: string
  criticIssuesDigest: string
}

export interface ProjectProxyCompletionLease {
  readonly owner: string
  readonly attempt: number
  readonly now: string
}

export interface ProjectProxyRenderRepository {
  /**
   * The operation already admitted for exactly this Version and pre-render input hash (a render, or a render carried from an earlier Version),
   * or null. Optional: a repository without it simply never short-circuits an enqueue.
   */
  findAdmittedOperationId?(input: { workspaceId: string; projectId: string; projectVersionId: string; inputHash: string }): Promise<string | null>
  /** `variantId`: the State variant to consume; absent means the State's only output. */
  readCurrentSource(input: { workspaceId: string; projectId: string; purpose?: ProjectRenderConsumptionPurpose; variantId?: string }): Promise<Readonly<ProjectProxyRenderSource> | null>
  readImmutableSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    editPlanSnapshotId: string
    sourceArtifactId: string
    sourceManifestId: string
    purpose?: ProjectRenderConsumptionPurpose
    /** The State variant to consume; absent means the State's only output. */
    variantId?: string
    /**
     * A worker sealed to a Version that is no longer the project's head can never publish (admission and completion both fence on
     * the head), so it refuses before it renders anything: PERSISTENCE_CONFLICT when the head moved. Off by default: the read is
     * otherwise of the exact Version, whichever the head is.
     */
    requireCurrent?: boolean
  }): Promise<Readonly<ProjectProxyRenderSource> | null>
  readRenderableSnapshotSource(input: {
    workspaceId: string
    projectId: string
    planId: string
    planHash: string
    format: string
    /** The State variant of the plan's Version to consume; absent means that State's only output. */
    variantId?: string
  }): Promise<Readonly<ProjectProxyRenderSource> | null>
  attachCompletedOutput(input: {
    lease: Readonly<ProjectProxyCompletionLease>
    review: Readonly<ProxyReview>
    workspaceId: string
    operationId: string
    projectId: string
    projectVersionId: string
    /** The stable State variant the render was made for (never an aspect ratio): invalidations it resolves are attributed to it. */
    variantId: string
    /** The aspect ratio the render drew (the sealed entry's); the recipe records the same. */
    format: string
    outputArtifactId: string
    outputManifestId: string
    originalFileName: string
    createdAt: string
    recipeParameters: Readonly<Record<string, unknown>>
    ocrReceipt: Readonly<ProjectProxyOcrReceipt> | null
    /**
     * W70 readiness (R2). The digests of what the content address cannot see, taken when these frames were decided: the face windows the
     * placement read (with the ones it still needs) and the Director's issues the review is built over. Stored on the render's operation row;
     * a carry from this render is refused when the head's are not the same (`face-evidence-moved`, `critic-issues-moved`).
     */
    renderEvidence?: Readonly<ProjectProxyRenderEvidence>
  }): Promise<void>
  attachCompletedSnapshotOutput(input: {
    lease: Readonly<ProjectProxyCompletionLease>
    review: Readonly<ProxyReview>
    workspaceId: string
    operationId: string
    projectId: string
    /** The LOCALIZATION variant of the renderable snapshot (`renderableVariantId`); the output is the operation's own `outputVariantId`. */
    variantId: string
    outputArtifactId: string
    outputManifestId: string
    originalFileName: string
    createdAt: string
    recipeParameters: Readonly<Record<string, unknown>>
    ocrReceipt: null
  }): Promise<void>
}
