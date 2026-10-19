import type { PerceptionProducerEnvelope } from '../../domain/perception-producer-envelope.ts'

export type PerceptionProducerClaim = Readonly<{
  operationId: string; workspaceId: string; projectId: string; projectVersionId: string
  sourceArtifactId: string; sourceSha256: string; sourceByteSize: number; artifactKey: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  timeMap: PerceptionProducerEnvelope['timeMap']; timelineDurationFrames: number
  timelineFps: PerceptionProducerEnvelope['timelineFps']; sampleIntervalFrames: number; attempt: number
}>

export interface PerceptionProducerWorkerRepository {
  claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }): Promise<PerceptionProducerClaim | null>
  heartbeat(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; leaseMs: number }): Promise<boolean>
  advancePhase(input: { operationId: string; attempt: number; leaseOwner: string; now: Date;
    phase: 'transcribing' | 'verifying' | 'persisting' }): Promise<boolean>
  currentFenceHash(input: { operationId: string; attempt: number; leaseOwner: string; now: Date }): Promise<string>
  publish(input: { envelope: PerceptionProducerEnvelope; leaseOwner: string; now: Date }): Promise<unknown>
  failAttempt(input: { operationId: string; attempt: number; leaseOwner: string; now: Date;
    errorCode: string; errorMessage: string; retryable: boolean }): Promise<boolean>
}

export interface OcrVideoAnalyzer {
  analyze(input: { sourcePath: string; expectedSourceSha256: string; workDirectory: string
    sampleIntervalFrames: number; maxSamples: number; timelineFps: PerceptionProducerEnvelope['timelineFps']
    signal?: AbortSignal }): Promise<Readonly<{
      sourceTimebase: PerceptionProducerEnvelope['sourceTimebase']
      sourceFps: PerceptionProducerEnvelope['sourceFps']
      sourcePtsStart: number; sourceClock: 'constant-frame-rate'
      producer: Omit<PerceptionProducerEnvelope['producer'], 'ffmpegSha256' | 'ffprobeSha256'>
      runtime: Readonly<{ ffmpegSha256: string; ffprobeSha256: string }>
      samples: readonly Omit<PerceptionProducerEnvelope['samples'][number], 'timelineFrame'>[]
    }>>
}
