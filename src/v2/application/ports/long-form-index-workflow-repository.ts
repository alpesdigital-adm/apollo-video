import type {
  LongFormIndexWorkflow,
} from '../../domain/long-form-index-workflow.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type {
  PublicOperation,
} from '../../domain/public-operation.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface LongFormIndexWorkflowSourceContext {
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  durationMs: number
  probeOutputHash: string
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  rightsExpiresAt?: string
  consentExpiresAt?: string
  sourceTranscript?: Readonly<{
    id: string
    transcriptHash: string
    resultCount: number
  }>
}

export interface PersistedLongFormIndexWorkflow {
  workflow: Readonly<LongFormIndexWorkflow>
  operation: Readonly<PublicOperation>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  requestFingerprint: string
  idempotencyKey: string
}

export interface LongFormIndexWorkflowPage {
  workflows:
    readonly Readonly<PersistedLongFormIndexWorkflow>[]
  nextCursor?: string
}

export interface LongFormTranscriptStageContext {
  operationId: string
  createdByClientId: string
  sourceArtifactId: string
  sourceArtifactKey: string
  sourceArtifactByteSize: bigint
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  durationMs: number
  language: string
  stageStatus: 'running' | 'succeeded'
  stageInputHash: string
  stageIdempotencyKey: string
}

export interface LongFormIndexWorkflowRepository {
  readSourceContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    sourceTranscriptId?: string
  }): Promise<Readonly<LongFormIndexWorkflowSourceContext> | null>
  findReplay(input: {
    workspaceId: string
    projectId: string
    createdByClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedLongFormIndexWorkflow> | null>
  create(input: {
    workflow: Readonly<LongFormIndexWorkflow>
    operation: Readonly<PublicOperation>
    authenticationAudit: Readonly<ApiAccessAuditContext>
    requestFingerprint: string
    idempotencyKey: string
    expectedRightsSnapshotId: string
    traceId?: string
  }): Promise<Readonly<{
    record: Readonly<PersistedLongFormIndexWorkflow>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    workflowId: string
  }): Promise<Readonly<PersistedLongFormIndexWorkflow> | null>
  list(input: {
    workspaceId: string
    projectId: string
    status?: LongFormIndexWorkflow['status']
    sourceArtifactId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<LongFormIndexWorkflowPage>>
  readTranscriptStageContext(input: {
    workspaceId: string
    projectId: string
    workflowId: string
  }): Promise<Readonly<LongFormTranscriptStageContext> | null>
  findTranscriptStageReplay(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    provider: string
    model: string
    providerVersion: string
  }): Promise<Readonly<{
    id: string
    transcript: Readonly<MediaTranscript>
  }> | null>
  persistTranscriptWithLease(input: {
    workspaceId: string
    projectId: string
    workflowId: string
    operationId: string
    expectedStageInputHash: string
    expectedStageIdempotencyKey: string
    leaseOwner: string
    operationAttempt: number
    transcriptId: string
    transcript: Readonly<MediaTranscript>
    providerVersion: string
    sourceArtifactId: string
    sourceArtifactSha256: string
    sourceManifestId: string
    sourceManifestHash: string
    now: string
  }): Promise<Readonly<{
    id: string
    transcript: Readonly<MediaTranscript>
    replayed: boolean
  }> | null>
  replaceWithLease(input: {
    workspaceId: string
    projectId: string
    workflowId: string
    operationId: string
    expectedRunHash: string
    nextWorkflow: Readonly<LongFormIndexWorkflow>
    leaseOwner: string
    operationAttempt: number
    now: string
  }): Promise<Readonly<LongFormIndexWorkflow> | null>
}
