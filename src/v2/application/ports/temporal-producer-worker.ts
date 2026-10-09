import type { TemporalProducerEnvelope } from '../../domain/temporal-producer-envelope.ts'

export type TemporalProducerClaim = Readonly<{
  operationId: string; workspaceId: string; projectId: string; projectVersionId: string
  sourceArtifactId: string; sourceSha256: string; sourceByteSize: number; artifactKey: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  timeMap: TemporalProducerEnvelope['timeMap']
  timelineDurationFrames: number; timelineFps: TemporalProducerEnvelope['timelineFps']
  attempt: number
}>

export interface TemporalProducerWorkerRepository {
  claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }): Promise<TemporalProducerClaim | null>
  heartbeat(input: { operationId: string; attempt: number; leaseOwner: string;
    now: Date; leaseMs: number }): Promise<boolean>
  advancePhase(input: { operationId: string; attempt: number; leaseOwner: string; now: Date;
    phase: 'analyzing' | 'verifying' | 'persisting' }): Promise<boolean>
  currentFenceHash(input: { operationId: string; attempt: number; leaseOwner: string;
    now: Date }): Promise<string>
  publish(input: { envelope: TemporalProducerEnvelope; leaseOwner: string; now: Date }): Promise<unknown>
  failAttempt(input: { operationId: string; attempt: number; leaseOwner: string; now: Date;
    errorCode: string; errorMessage: string; retryable: boolean }): Promise<boolean>
}
