import type { FaceProducerEnvelopeV3 } from '../../domain/face-producer-envelope-v3.ts'

/**
 * One window of the SOURCE's own frames, claimed by a face worker for the V9 source profile (W65b). The project and Version the
 * window was requested from are only audit context: the worker observes the source and publishes evidence about it.
 */
export type FaceSourceWindowClaim = Readonly<{
  operationId: string; workspaceId: string; projectId: string; projectVersionId: string
  sourceArtifactId: string; sourceSha256: string; sourceByteSize: number; artifactKey: string
  /** Integer frame rate of the source from its manifest probe: the analyzer refuses a source that measures differently. */
  sourceFps: number
  window: FaceProducerEnvelopeV3['window']
  sampleIntervalFrames: number; attempt: number
}>

/** Durable implementation revalidates rights, source and fence before publishing, in one transaction. */
export interface FaceSourceWindowWorkerRepository {
  claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }): Promise<FaceSourceWindowClaim | null>
  heartbeat(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; leaseMs: number }): Promise<boolean>
  advancePhase(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; phase: 'analyzing' | 'verifying' | 'persisting' }): Promise<boolean>
  currentFenceHash(input: { operationId: string; attempt: number; leaseOwner: string; now: Date }): Promise<string>
  /** `rawOutputs[i]` is the 5600-byte detector output of `envelope.samples[i]`, or null when the detector produced none. */
  publish(input: { envelope: FaceProducerEnvelopeV3; rawOutputs: readonly (Uint8Array | null)[]; leaseOwner: string; now: Date }): Promise<unknown>
  failAttempt(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; errorCode: string; errorMessage: string; retryable: boolean }): Promise<boolean>
}
