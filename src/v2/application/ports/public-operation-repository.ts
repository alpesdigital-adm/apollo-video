import type {
  PublicOperation,
  PublicOperationError,
  PublicOperationRunningPhase,
  PublicOperationStatus,
} from '../../domain/public-operation.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { StrategicObjectiveId } from '../../domain/strategic-objective.ts'
import type { DesiredAction } from '../../domain/desired-action.ts'
import type { RenderColorPipelineBinding } from '../resolve-render-color-pipelines.ts'
import type {
  SyntheticProductionRenderAspectRatio,
  SyntheticProductionRenderKind,
} from '../../domain/synthetic-production-render.ts'
import type { RenderInputSpecV1 } from '../../domain/render-input.ts'

export interface ArtifactRenderOperationContext {
  kind: 'artifact-render'
  authorizationId: string
  inputHash: string
}

export interface SyntheticProductionRenderOperationContext {
  kind: 'synthetic-production-render'
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  productionRunId: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
  planHash: string
  outputKind: SyntheticProductionRenderKind
  aspectRatio: SyntheticProductionRenderAspectRatio
  renderInputRef: string
  renderInputHash: string
  propsHash: string
  outputArtifactId: string
  outputManifestId: string
  contextHash: string
  /** Present only while atomically creating the protected payload and operation. */
  renderInput?: Readonly<RenderInputSpecV1>
}

export interface MediaIngestOperationContext {
  kind: 'media-ingest'
  uploadId: string
  projectId: string
  originalFileName: string
  sourceArtifactId: string
  sourceManifestId: string
}

export interface ProjectProxyRenderOperationContext {
  kind: 'project-proxy-render'
  projectId: string
  projectVersionId: string
  editPlanSnapshotId: string
  sourceArtifactId: string
  sourceManifestId: string
  colorPipelineBindings: readonly Readonly<RenderColorPipelineBinding>[]
  inputHash: string
  outputArtifactId: string
  outputManifestId: string
  originalFileName: string
  /**
   * The stable State variant this render is for (the output its sealed consumption named at enqueue). Absent only on a row written
   * before the column existed: such a row belongs to the State's only output, and to none when the State has several.
   */
  outputVariantId?: string
  renderableSnapshot?: Readonly<{
    planId: string
    planHash: string
    origin: 'localization' | 'music-led-montage'
    sourceId: string
    sourceHash: string
    variantId: string
    format: string
  }>
}

export interface ProjectProxyReuseOperationContext {
  kind: 'project-proxy-reuse'
  projectId: string
  projectVersionId: string
  editPlanSnapshotId: string
  commandId: string
  impactHash: string
  baseVersionId: string
  reusedFromOperationId: string
  sourceArtifactId: string
  sourceManifestId: string
  inputHash: string
  outputArtifactId: string
  outputManifestId: string
  originalFileName: string
  /** The stable State variant whose base proxy this reuse carries over (absent only on a legacy row: the State's only output). */
  outputVariantId?: string
}

export interface ProjectFinalExportOperationContext {
  kind: 'project-final-export'
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  editPlanSnapshotId: string
  directorRunId: string
  qualitySnapshotId: string
  qualitySnapshotHash: string
  proxyReviewId: string
  proxyReviewHash: string
  proxyArtifactId: string
  sourceArtifactId: string
  sourceManifestId: string
  colorPipelineBindings: readonly Readonly<RenderColorPipelineBinding>[]
  inputHash: string
  outputArtifactId: string
  outputManifestId: string
  outputSpec: {
    aspectRatio: '9:16' | '16:9' | '4:5' | '1:1' | '21:9'
    width: number
    height: number
    fps: number
    codec: 'h264'
    audioCodec: 'aac'
    container: 'mp4'
    quality: 'final'
  }
  approval: {
    actorType: 'api-client' | 'user'
    actorId: string
    approvedAt: string
    note?: string
  }
  originalFileName: string
  /**
   * The stable State variant this export is for; `outputSpec.aspectRatio` is the aspect ratio of that output's entry. Absent only
   * on a row written before the column existed: such a row belongs to the output whose ratio it states, when exactly one has it.
   */
  outputVariantId?: string
}

export interface SourceCleanupOperationContext {
  kind: 'source-cleanup'
  projectId: string
  cleanupPlanId: string
  cleanupPlanHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  outputArtifactId: string
  outputManifestId: string
  strategy: 'trim' | 'crop-reframe' | 'cover' | 'separation'
}

export interface LongFormIndexOperationContext {
  kind: 'long-form-index'
  projectId: string
  workflowId: string
  sourceArtifactId: string
  sourceManifestId: string
}

export interface ProjectDirectorRunOperationContext {
  kind: 'project-director-run'
  projectId: string
  baseVersionId: string
  baseHash: string
  resultVersionId: string
  baseObjective: StrategicObjectiveId
  objective: StrategicObjectiveId
  objectiveVersion: number
  rubricRef: string
  supersedesRunId?: string
  desiredAction?: Readonly<DesiredAction>
  delegatedUserId?: string
  reason?: string
}

export interface PerceptionProducerRunOperationContext {
  kind: 'perception-producer-run'
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  sourceArtifactId: string
  sourceSha256: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
  sampleIntervalFrames: number
  requestHash: string
}

export interface TemporalProducerRunOperationContext {
  kind: 'perception-temporal-run'
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  sourceArtifactId: string
  sourceSha256: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
  requestHash: string
}

export interface FaceProducerRunOperationContext {
  kind: 'perception-face-run'
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  sourceArtifactId: string
  sourceSha256: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
  sampleIntervalFrames: number
  requestHash: string
  /** Server-side detector pipeline that claims the operation; absent on creation means the legacy YuNet diagnostic. */
  detectorProfile?: FaceDetectorProfile
  /** Timeline window [startTimelineFrame, endTimelineFrame) of at most 300 frames; required for the V9 timeline profile, absent otherwise. */
  window?: Readonly<{ startTimelineFrame: number; endTimelineFrame: number }>
  /**
   * W65b. Window [startSourceFrame, endSourceFrame) of at most 300 frames of the SOURCE's own timeline; required for the V9 source profile,
   * absent otherwise. The project/version/EditPlan fields are then only the context the window was requested from.
   */
  sourceWindow?: Readonly<{ startSourceFrame: number; endSourceFrame: number }>
}

export type FaceDetectorProfile = 'yunet-v5-diagnostic' | 'openvino-face0204-v9' | 'openvino-face0204-v9-source'

export type PublicOperationContext =
  | ArtifactRenderOperationContext
  | SyntheticProductionRenderOperationContext
  | MediaIngestOperationContext
  | ProjectProxyRenderOperationContext
  | ProjectProxyReuseOperationContext
  | ProjectFinalExportOperationContext
  | SourceCleanupOperationContext
  | LongFormIndexOperationContext
  | ProjectDirectorRunOperationContext
  | PerceptionProducerRunOperationContext
  | TemporalProducerRunOperationContext
  | FaceProducerRunOperationContext

export type PublicOperationCreationContext = Exclude<
  PublicOperationContext,
  SourceCleanupOperationContext | LongFormIndexOperationContext
>

export interface PublicOperationRecord {
  operation: Readonly<PublicOperation>
  context: Readonly<PublicOperationContext>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  traceId?: string
}

export interface PublicOperationPersistenceResult extends PublicOperationRecord {
  replayed: boolean
}

export interface PublicOperationLease {
  owner: string
  attempt: number
  heartbeatAt: string
  expiresAt: string
}

export interface ClaimedPublicOperationRecord extends PublicOperationRecord {
  lease: Readonly<PublicOperationLease>
}

export interface PublicOperationListQuery {
  workspaceId: string
  projectId?: string
  limit: number
  status?: PublicOperationStatus
  type?: PublicOperation['type']
  targetId?: string
  deadLettered?: boolean
  after?: {
    createdAt: string
    id: string
  }
}

export interface PublicOperationLeaseCommand {
  operationId: string
  leaseOwner: string
  attempt: number
  now: string
}

export interface ResumeWaitingPublicOperationCommand {
  workspaceId: string
  operationId: string
  leaseOwner: string
  attempt: number
  phase: PublicOperationRunningPhase
  now: string
  leaseUntil: string
}

export interface PublicOperationRepository {
  findById(workspaceId: string, operationId: string): Promise<PublicOperationRecord | null>
  list(input: PublicOperationListQuery): Promise<readonly PublicOperationRecord[]>
  cancel(input: {
    workspaceId: string
    operationId: string
    commandId: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    canceledAt: string
  }): Promise<PublicOperationRecord | null>
  retry(input: {
    workspaceId: string
    operationId: string
    commandId: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    requestedAt: string
    nextAttemptAt: string
  }): Promise<PublicOperationRecord | null>
  findReplay(input: {
    workspaceId: string
    clientId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult | null>
  createOrReplay(input: {
    operation: PublicOperation
    authenticationAudit: Readonly<ApiAccessAuditContext>
    context: PublicOperationCreationContext
    idempotencyKey: string
    requestFingerprint: string
    traceId?: string
  }): Promise<PublicOperationPersistenceResult>
  claimNext(input: {
    leaseOwner: string
    now: string
    leaseUntil: string
    workspaceId?: string
    operationId?: string
    type?: PublicOperation['type']
  }): Promise<ClaimedPublicOperationRecord | null>
  heartbeat(input: PublicOperationLeaseCommand & {
    leaseUntil: string
  }): Promise<boolean>
  advancePhase(input: PublicOperationLeaseCommand & {
    phase: PublicOperationRunningPhase
  }): Promise<boolean>
  wait(input: PublicOperationLeaseCommand): Promise<PublicOperationRecord | null>
  resumeWaiting(
    input: ResumeWaitingPublicOperationCommand,
  ): Promise<ClaimedPublicOperationRecord | null>
  succeed(input: PublicOperationLeaseCommand): Promise<PublicOperationRecord | null>
  failOrRetry(input: PublicOperationLeaseCommand & {
    error: PublicOperationError
    nextAttemptAt?: string
  }): Promise<PublicOperationRecord | null>
}
