import type {
  PublicOperation,
  PublicOperationError,
  PublicOperationRunningPhase,
  PublicOperationStatus,
} from '../../domain/public-operation.ts'

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
    context: ArtifactRenderOperationContext
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult>
  claimNext(input: {
    leaseOwner: string
    now: string
    leaseUntil: string
    workspaceId?: string
  }): Promise<ClaimedPublicOperationRecord | null>
  heartbeat(input: PublicOperationLeaseCommand & {
    leaseUntil: string
  }): Promise<boolean>
  advancePhase(input: PublicOperationLeaseCommand & {
    phase: PublicOperationRunningPhase
  }): Promise<boolean>
  succeed(input: PublicOperationLeaseCommand): Promise<PublicOperationRecord | null>
  failOrRetry(input: PublicOperationLeaseCommand & {
    error: PublicOperationError
    nextAttemptAt?: string
  }): Promise<PublicOperationRecord | null>
}
