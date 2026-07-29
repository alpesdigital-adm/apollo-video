import type {
  SpeakerDiarizationRun,
} from '../../domain/speaker-diarization.ts'

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
  }): Promise<Readonly<SpeakerDiarizationRun> | null>
  findReplay(input: {
    workspaceId: string
    workflowId: string
    idempotencyKey: string
  }): Promise<Readonly<SpeakerDiarizationRun> | null>
  persistWithLease(input: {
    run: Readonly<SpeakerDiarizationRun>
    operationId: string
    leaseOwner: string
    operationAttempt: number
    expectedStageInputHash: string
    now: string
  }): Promise<Readonly<{
    run: Readonly<SpeakerDiarizationRun>
    replayed: boolean
  }> | null>
}
