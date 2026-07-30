export interface LongFormStagePersistenceFence {
  workspaceId: string
  projectId: string
  workflowId: string
  operationId: string
  stage: 'chunks' | 'moments'
  expectedStageInputHash: string
  expectedStageIdempotencyKey: string
  leaseOwner: string
  operationAttempt: number
  now: string
}
