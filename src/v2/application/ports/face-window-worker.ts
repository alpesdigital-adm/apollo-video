import type { FaceDetectorConfigV2, FaceProducerEnvelopeV2, FaceProducerV2, FaceSampleV2, FaceTimeMapRangeV2 } from '../../domain/face-producer-envelope-v2.ts'

/** One window of one single-clip, unit-rate source, claimed by a face worker for the V9 detector profile. */
export type FaceWindowClaim = Readonly<{
  operationId: string; workspaceId: string; projectId: string; projectVersionId: string
  sourceArtifactId: string; sourceSha256: string; sourceByteSize: number; artifactKey: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  timeMap: readonly FaceTimeMapRangeV2[]
  timelineDurationFrames: number; timelineFps: FaceProducerEnvelopeV2['timelineFps']
  window: FaceProducerEnvelopeV2['window']
  sampleIntervalFrames: number; attempt: number
}>

/** Durable implementation revalidates rights, source, version and fence before publishing, in one transaction. */
export interface FaceWindowWorkerRepository {
  claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }): Promise<FaceWindowClaim | null>
  heartbeat(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; leaseMs: number }): Promise<boolean>
  advancePhase(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; phase: 'analyzing' | 'verifying' | 'persisting' }): Promise<boolean>
  currentFenceHash(input: { operationId: string; attempt: number; leaseOwner: string; now: Date }): Promise<string>
  /** `rawOutputs[i]` is the 5600-byte detector output of `envelope.samples[i]`, or null when the detector produced none. */
  publish(input: { envelope: FaceProducerEnvelopeV2; rawOutputs: readonly (Uint8Array | null)[]; leaseOwner: string; now: Date }): Promise<unknown>
  failAttempt(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; errorCode: string; errorMessage: string; retryable: boolean }): Promise<boolean>
}

export type FaceWindowAnalysis = Readonly<{
  sourceTimebase: FaceProducerEnvelopeV2['sourceTimebase']
  sourceFps: FaceProducerEnvelopeV2['sourceFps']
  sourcePtsStart: number
  sourceClock: 'constant-frame-rate'
  sourcePtsRounding: 'nearest'
  /** Read from the verified source probe, never copied from the request. */
  sourceWidth: number; sourceHeight: number
  sourceOrientation: 'rotation-0-exif-neutral'
  detectorConfig: FaceDetectorConfigV2
  producer: FaceProducerV2
  samples: readonly Omit<FaceSampleV2, 'timelineFrame'>[]
  rawOutputs: readonly (Uint8Array | null)[]
}>

/** Adapter returns source-frame evidence; it never claims safe placement or identity. */
export interface FaceWindowAnalyzer {
  analyze(input: {
    sourcePath: string; expectedSourceSha256: string; workDirectory: string
    /** Source frames [sourceInFrame, sourceOutFrame) of the window; samples are the multiples of the interval inside it. */
    sourceInFrame: number; sourceOutFrame: number
    sampleIntervalFrames: number; maxSamples: number
    timelineFps: FaceProducerEnvelopeV2['timelineFps']; signal?: AbortSignal
  }): Promise<FaceWindowAnalysis>
}
