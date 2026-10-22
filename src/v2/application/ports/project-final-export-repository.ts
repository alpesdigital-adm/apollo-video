import type { DirectorRunInheritance } from '../../domain/director-run-inheritance.ts'
import type { ProjectProxyRenderSource } from './project-proxy-render-repository.ts'

export interface ApprovedProjectFinalExportSource extends ProjectProxyRenderSource {
  projectVersionHash: string
  locale: string
  directorRunId: string
  /**
   * W70 readiness. Present when `directorRunId` is the run of an ANCESTOR of the exported Version, reached through exception Commands only
   * (a subtitle segment exception, a manual reframe): the Versions and Commands the Director's quality went through. Absent when the exported
   * Version is the Director's own. It is part of the final's input hash and of its receipt; the worker re-derives it and refuses a chain that moved.
   */
  directorInheritance?: Readonly<DirectorRunInheritance>
  qualitySnapshotId: string
  qualitySnapshotHash: string
  qualityStatus: 'approved' | 'approved-with-warnings' | 'review-required'
  /**
   * Why the Director's report is admissible for a final (W65b): a verified face safety (legacy), or the per-cue caption
   * certification the final worker performs on what it burns. Neither ever sets a global face safety.
   */
  admissionBasis: 'verified-face-safety' | 'per-cue-caption-certification'
  qualityScore: number
  proxyReviewId: string
  proxyReviewHash: string
  proxyArtifactId: string
  /**
   * W66r. The content address of the render reframe plan the approved proxy was drawn from, or null when it was drawn without one. The final
   * is made from the same plan: a plan persisted after the approval is not the geometry the reviewer approved.
   */
  approvedReframePlanHash: string | null
  /**
   * W68. The set of per-segment subtitle exceptions the approved proxy was drawn with, or null when it was drawn with none. The final is made
   * from the same set: an exception applied after the approval is not what the reviewer saw.
   */
  approvedSubtitleOverridesHash: string | null
}

export interface ProjectFinalExportAttemptHistory {
  operationId: string
  projectId: string
  projectVersionId: string
  proxyReviewId: string
  outputSpec: Readonly<{
    aspectRatio: '9:16' | '16:9' | '4:5' | '1:1' | '21:9'
    width: number
    height: number
    fps: number
    codec: 'h264'
    audioCodec: 'aac'
    container: 'mp4'
    quality: 'final'
  }>
  attempts: readonly Readonly<{
    attempt: number
    status: 'failed' | 'promoted'
    validators: readonly Readonly<{
      code: string
      passed: boolean
      message: string
    }>[]
    output?: Readonly<{
      artifactId: string
      manifestId: string
      sha256: string
      byteSize: number
    }>
    error?: Readonly<{
      code: string
      message: string
      stage?: ProjectFinalExportFailureStage
    }>
    startedAt: string
    completedAt: string
  }>[]
}

export type ProjectFinalExportFailureStage =
  | 'source-read' | 'color-plan' | 'color-bindings' | 'lut-materialization'
  | 'input-validation' | 'rights' | 'source-materialization' | 'render'
  | 'output-verification' | 'output-promotion' | 'artifact-persistence'

export interface ProjectFinalExportRepository {
  readApprovedCurrentSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    /** The State variant to export; absent means the State's only output. */
    variantId?: string
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null>
  /**
   * The stable variant of the only output of `projectVersionId` whose sealed aspect ratio is `format` (null when none has it; two
   * outputs of one ratio are refused with `output-variant-ambiguous`). For callers whose request names a format and not a variant
   * (an export matrix cell): the format of a cell is explicit, so addressing the output by it is exact, never a guess.
   */
  resolveOutputVariantByFormat(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    format: string
  }): Promise<string | null>
  readImmutableApprovedSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    editPlanSnapshotId: string
    directorRunId: string
    /**
     * The inheritance the operation was queued with (`null`: the Version was the Director's own). The repository re-derives the walk and
     * refuses, with a precise reason, a chain that is not exactly this one.
     */
    directorInheritance?: Readonly<DirectorRunInheritance> | null
    qualitySnapshotId: string
    qualitySnapshotHash: string
    proxyReviewId: string
    proxyReviewHash: string
    proxyArtifactId: string
    sourceArtifactId: string
    sourceManifestId: string
    /** The State variant to export; absent means the State's only output. */
    variantId?: string
    /** The worker refuses (PERSISTENCE_CONFLICT), before it renders anything, when the sealed Version is no longer the project's head. */
    requireCurrent?: boolean
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null>
  convergeOutputIdentity(input: {
    workspaceId: string
    operationId: string
    reservedArtifactId: string
    reservedManifestId: string
    persistedArtifactId: string
    persistedManifestId: string
    leaseOwner: string
    attempt: number
    now: string
  }): Promise<void>
  attachCompletedOutput(input: {
    workspaceId: string
    operationId: string
    projectId: string
    projectVersionId: string
    outputArtifactId: string
    outputManifestId: string
    originalFileName: string
    createdAt: string
  }): Promise<void>
  markExportFailed(input: {
    workspaceId: string
    operationId: string
    projectId: string
  }): Promise<void>
  recordAttempt(input: {
    workspaceId: string
    operationId: string
    leaseOwner: string
    attempt: number
    status: 'failed' | 'promoted'
    validators: readonly Readonly<{
      code: string
      passed: boolean
      message: string
    }>[]
    output?: Readonly<{
      artifactId: string
      manifestId: string
      sha256: string
      byteSize: number
    }>
    error?: Readonly<{
      code: string
      message: string
      stage?: ProjectFinalExportFailureStage
    }>
    startedAt: string
    completedAt: string
  }): Promise<void>
  readAttemptHistory(input: {
    workspaceId: string
    operationId: string
  }): Promise<Readonly<ProjectFinalExportAttemptHistory> | null>
}
