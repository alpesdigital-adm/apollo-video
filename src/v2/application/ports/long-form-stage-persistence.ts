import type {
  ApiAccessAuditContext,
} from '../../domain/api-access-control.ts'

export interface LongFormStagePersistenceFence {
  workspaceId: string
  projectId: string
  workflowId: string
  operationId: string
  stage: ProjectAnalysisStage
  expectedStageInputHash: string
  expectedStageIdempotencyKey: string
  leaseOwner: string
  operationAttempt: number
  now: string
}

export type ProjectAnalysisStage = 'diarization' | 'chunks' | 'moments'

export type ProjectAnalysisExecutionProvenance =
  | Readonly<{
      kind: 'external-request'
    }>
  | Readonly<{
      kind: 'long-form-stage'
      workflowId: string
      operationId: string
      stage: ProjectAnalysisStage
      stageInputHash: string
      stageIdempotencyKey: string
    }>

export interface ProjectAnalysisExecutionContext {
  authenticationAudit: Readonly<ApiAccessAuditContext>
  provenance: ProjectAnalysisExecutionProvenance
}
