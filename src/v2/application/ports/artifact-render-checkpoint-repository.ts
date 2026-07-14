import type { CommittedRenderReceipt } from './render-input-renderer.ts'
import type { PublicOperationLeaseCommand } from './public-operation-repository.ts'

export interface ArtifactRenderCheckpoint {
  operationId: string
  workspaceId: string
  artifactId: string
  manifestId: string
  inputHash: string
  outputKey: string
  output: Readonly<CommittedRenderReceipt>
  attempt: number
  recordedAt: string
}

export interface ArtifactRenderCheckpointResult {
  checkpoint: Readonly<ArtifactRenderCheckpoint>
  replayed: boolean
}

export interface ArtifactRenderCheckpointRepository {
  findByOperationId(operationId: string): Promise<Readonly<ArtifactRenderCheckpoint> | null>
  record(input: PublicOperationLeaseCommand & {
    outputKey: string
    output: CommittedRenderReceipt
  }): Promise<ArtifactRenderCheckpointResult | null>
}
