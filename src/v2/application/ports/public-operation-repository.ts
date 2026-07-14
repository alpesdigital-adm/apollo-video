import type { PublicOperation } from '../../domain/public-operation.ts'

export interface ArtifactRenderOperationContext {
  authorizationId: string
  inputHash: string
}

export interface PublicOperationRecord {
  operation: Readonly<PublicOperation>
  context: Readonly<ArtifactRenderOperationContext>
}

export interface PublicOperationPersistenceResult extends PublicOperationRecord {
  replayed: boolean
}

export interface PublicOperationRepository {
  findById(workspaceId: string, operationId: string): Promise<PublicOperationRecord | null>
  findReplay(input: {
    workspaceId: string
    clientId: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult | null>
  createOrReplay(input: {
    operation: PublicOperation
    context: ArtifactRenderOperationContext
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult>
}
