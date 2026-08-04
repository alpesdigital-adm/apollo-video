import type {
  SpeakerDiarizationRun,
} from '../../domain/speaker-diarization.ts'
import type {
  ApiAccessAuditContext,
} from '../../domain/api-access-control.ts'
import type {
  ProjectAnalysisExecutionContext,
} from './long-form-stage-persistence.ts'

export interface PersistedSpeakerDiarizationRun
extends SpeakerDiarizationRun, ProjectAnalysisExecutionContext {}

export interface SpeakerDiarizationSourceContext {
  operationId: string
  createdByClientId: string
  sourceArtifactId: string
  sourceArtifactKey: string
  sourceArtifactByteSize: bigint
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  language: string
  durationMs: number
  stageStatus: 'running' | 'succeeded'
  stageInputHash: string
  stageIdempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface SpeakerDiarizationRepository {
  readSourceContext(input: {
    workspaceId: string
    projectId: string
    workflowId: string
  }): Promise<Readonly<SpeakerDiarizationSourceContext> | null>
  findRun(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<PersistedSpeakerDiarizationRun> | null>
  findReplay(input: {
    workspaceId: string
    workflowId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSpeakerDiarizationRun> | null>
  persistWithLease(input: {
    run: Readonly<PersistedSpeakerDiarizationRun>
    operationId: string
    leaseOwner: string
    operationAttempt: number
    expectedStageInputHash: string
    now: string
  }): Promise<Readonly<{
    run: Readonly<PersistedSpeakerDiarizationRun>
    replayed: boolean
  }> | null>
}
