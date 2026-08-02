import type {
  PublicOperation,
  PublicOperationError,
  PublicOperationRunningPhase,
  PublicOperationStatus,
} from '../../domain/public-operation.ts'
import type { RenderColorPipelineBinding } from '../resolve-render-color-pipelines.ts'

export interface ArtifactRenderOperationContext {
  kind: 'artifact-render'
  authorizationId: string
  inputHash: string
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
  strategy: 'trim' | 'crop-reframe' | 'cover'
}

export interface LongFormIndexOperationContext {
  kind: 'long-form-index'
  projectId: string
  workflowId: string
  sourceArtifactId: string
  sourceManifestId: string
}

export type PublicOperationContext =
  | ArtifactRenderOperationContext
  | MediaIngestOperationContext
  | ProjectProxyRenderOperationContext
  | ProjectProxyReuseOperationContext
  | ProjectFinalExportOperationContext
  | SourceCleanupOperationContext
  | LongFormIndexOperationContext

export type PublicOperationCreationContext = Exclude<
  PublicOperationContext,
  SourceCleanupOperationContext | LongFormIndexOperationContext
>

export interface PublicOperationRecord {
  operation: Readonly<PublicOperation>
  context: Readonly<PublicOperationContext>
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
    canceledAt: string
  }): Promise<PublicOperationRecord | null>
  retry(input: {
    workspaceId: string
    operationId: string
    requestedAt: string
    nextAttemptAt: string
  }): Promise<PublicOperationRecord | null>
  findReplay(input: {
    workspaceId: string
    clientId: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult | null>
  createOrReplay(input: {
    operation: PublicOperation
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
