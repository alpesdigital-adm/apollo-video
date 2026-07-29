import type {
  LongFormIndexStageCheckpoint,
  LongFormIndexWorkflow,
} from '../../domain/long-form-index-workflow.ts'

export interface LongFormIndexStageResult {
  outputHash: string
  outputEntityId: string
  resultCount: number
  costMinorUnits: number
  elapsedMs: number
}

export interface LongFormIndexStageProcessor {
  process(input: {
    workflow: Readonly<LongFormIndexWorkflow>
    checkpoint: Readonly<LongFormIndexStageCheckpoint>
    lease: Readonly<{
      operationId: string
      owner: string
      attempt: number
    }>
    signal: AbortSignal
    heartbeat: () => Promise<boolean>
  }): Promise<Readonly<LongFormIndexStageResult>>
}
