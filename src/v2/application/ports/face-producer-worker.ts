import type { FaceProducerEnvelope } from '../../domain/face-producer-envelope.ts'

export type FaceProducerClaim = Readonly<{
  operationId: string; workspaceId: string; projectId: string; projectVersionId: string
  sourceArtifactId: string; sourceSha256: string; sourceByteSize: number; artifactKey: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  timeMap: FaceProducerEnvelope['timeMap']
  timelineDurationFrames: number; timelineFps: FaceProducerEnvelope['timelineFps']
  sampleIntervalFrames: number; attempt: number
}>

/** Durable implementation must revalidate rights, source, version and fence before publishing. */
export interface FaceProducerWorkerRepository {
  claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }): Promise<FaceProducerClaim | null>
  heartbeat(input: { operationId: string; attempt: number; leaseOwner: string;
    now: Date; leaseMs: number }): Promise<boolean>
  advancePhase(input: { operationId: string; attempt: number; leaseOwner: string;
    now: Date; phase: 'analyzing' | 'verifying' | 'persisting' }): Promise<boolean>
  currentFenceHash(input: { operationId: string; attempt: number;
    leaseOwner: string; now: Date }): Promise<string>
  publish(input: { envelope: FaceProducerEnvelope; leaseOwner: string; now: Date }): Promise<unknown>
  failAttempt(input: { operationId: string; attempt: number; leaseOwner: string;
    now: Date; errorCode: string; errorMessage: string; retryable: boolean }): Promise<boolean>
}

/** Adapter returns source-frame evidence, never a verified-human or safe-placement claim. */
export interface FaceVideoAnalyzer {
  analyze(input: { sourcePath: string; expectedSourceSha256: string; workDirectory: string
    sourceInFrame: number; sourceOutFrame: number
    sampleIntervalFrames: number; maxSamples: number
    timelineFps: FaceProducerEnvelope['timelineFps']; signal?: AbortSignal }): Promise<Readonly<{
      sourceTimebase: FaceProducerEnvelope['sourceTimebase']
      sourceFps: FaceProducerEnvelope['sourceFps']
      sourcePtsStart: number; sourceClock: 'constant-frame-rate'
      sourcePtsRounding: 'nearest'
      /** Read from the verified source probe, never copied from the request. */
      sourceWidth: FaceProducerEnvelope['sourceWidth']
      sourceHeight: FaceProducerEnvelope['sourceHeight']
      sourceOrientation: FaceProducerEnvelope['sourceOrientation']
      /** Exact runtime configuration used for these candidate boxes. */
      detectorConfig: FaceProducerEnvelope['detectorConfig']
      producer: FaceProducerEnvelope['producer']
      /** Frame dimensions and hashes come from the decoded frame bytes. */
      samples: readonly Omit<FaceProducerEnvelope['samples'][number], 'timelineFrame'>[]
    }>>
}
