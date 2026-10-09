import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { createFaceProducerEnvelope } from '../domain/face-producer-envelope.ts'
import { DomainError } from '../domain/errors.ts'
import type { ArtifactSourceMaterializer } from './ports/media-ingest.ts'
import type { FaceProducerClaim, FaceProducerWorkerRepository, FaceVideoAnalyzer } from './ports/face-producer-worker.ts'

const MAX_SOURCE_FRAMES = 300
const MAX_SAMPLES = 30

function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }

function mapSamples(claim: FaceProducerClaim,
  sourceSamples: Awaited<ReturnType<FaceVideoAnalyzer['analyze']>>['samples']) {
  const range = claim.timeMap[0]!
  const expected = Array.from({ length: range.sourceOutFrame - range.sourceInFrame },
    (_, index) => range.sourceInFrame + index)
    .filter((sourceFrame) => sourceFrame % claim.sampleIntervalFrames === 0)
  if (expected.length > MAX_SAMPLES || sourceSamples.length !== expected.length ||
      sourceSamples.some((sample, index) => sample.sourceFrame !== expected[index])) {
    invalid('Face analyzer did not return every requested source frame in order')
  }
  const samples = sourceSamples.map((sample) => ({ ...sample,
    timelineFrame: range.timelineInFrame + sample.sourceFrame - range.sourceInFrame }))
  const gaps: Array<{ startTimelineFrame: number; endTimelineFrame: number; reasonCode: string }> = []
  let cursor = 0
  for (const sample of samples) {
    if (sample.timelineFrame > cursor) gaps.push({ startTimelineFrame: cursor,
      endTimelineFrame: sample.timelineFrame, reasonCode: 'NOT_SAMPLED' })
    cursor = sample.timelineFrame + 1
  }
  if (cursor < claim.timelineDurationFrames) gaps.push({ startTimelineFrame: cursor,
    endTimelineFrame: claim.timelineDurationFrames, reasonCode: 'NOT_SAMPLED' })
  return { samples, gaps }
}

/** Runs one bounded source-video observation and persists only sampled, unverified face candidates. */
export function runNextFaceProducerOperationService(dependencies: {
  repository: FaceProducerWorkerRepository
  materializer: ArtifactSourceMaterializer
  analyzer: FaceVideoAnalyzer
  clock?: () => Date
  leaseMs?: number; heartbeatMs?: number; deadlineMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseMs = dependencies.leaseMs ?? 120_000
  const heartbeatMs = dependencies.heartbeatMs ?? 10_000
  const deadlineMs = dependencies.deadlineMs ?? 120_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 2_000 || leaseMs > 300_000 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs >= leaseMs / 2 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) {
    invalid('Face worker lease, heartbeat or deadline is invalid')
  }
  return async (leaseOwner: string, signal?: AbortSignal) => {
    if (signal?.aborted) return null
    const claim = await dependencies.repository.claimNext({ leaseOwner, now: clock(), leaseMs })
    if (!claim) return null
    const controller = new AbortController()
    const abortFromShutdown = () => controller.abort()
    signal?.addEventListener('abort', abortFromShutdown, { once: true })
    if (signal?.aborted) controller.abort()
    let heartbeatInFlight: Promise<void> = Promise.resolve()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const range = claim.timeMap[0]
      if (claim.timeMap.length !== 1 || !range || range.rate !== 1 ||
          range.sourceOutFrame > MAX_SOURCE_FRAMES ||
          range.sourceOutFrame <= range.sourceInFrame ||
          claim.timelineDurationFrames !== range.sourceOutFrame - range.sourceInFrame ||
          !Number.isSafeInteger(claim.sampleIntervalFrames) || claim.sampleIntervalFrames < 1 ||
          claim.sampleIntervalFrames > MAX_SOURCE_FRAMES ||
          !Number.isSafeInteger(claim.timelineDurationFrames) ||
          claim.timelineDurationFrames < 1 || claim.timelineDurationFrames > MAX_SOURCE_FRAMES) {
        invalid('Face producer supports one unit-rate, at-most-300-frame source clip')
      }
      const requestedSamples = Math.floor((range.sourceOutFrame - 1) / claim.sampleIntervalFrames) -
        Math.floor((range.sourceInFrame - 1) / claim.sampleIntervalFrames)
      if (requestedSamples < 1 || requestedSamples > MAX_SAMPLES) {
        invalid('Face sampling requires between one and thirty source frames')
      }
      heartbeat = setInterval(() => {
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          if (!await dependencies.repository.heartbeat({ operationId: claim.operationId,
            attempt: claim.attempt, leaseOwner, now: clock(), leaseMs })) controller.abort()
        }).catch(() => controller.abort())
      }, heartbeatMs)
      deadline = setTimeout(() => controller.abort(), deadlineMs)
      const materialized = await dependencies.materializer.materialize({
        operationId: claim.operationId, artifactKey: claim.artifactKey,
        sha256: claim.sourceSha256, byteSize: claim.sourceByteSize,
        signal: controller.signal,
      })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT',
        'Face producer was aborted before analysis')
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'analyzing' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer lost its lease before analysis')
      }
      const analysis = await dependencies.analyzer.analyze({
        sourcePath: materialized.path, expectedSourceSha256: claim.sourceSha256,
        workDirectory: dirname(materialized.path), sourceInFrame: range.sourceInFrame,
        sourceOutFrame: range.sourceOutFrame,
        sampleIntervalFrames: claim.sampleIntervalFrames,
        maxSamples: MAX_SAMPLES, timelineFps: claim.timelineFps, signal: controller.signal,
      })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT',
        'Face producer was aborted before verification')
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'verifying' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer lost its lease before verification')
      }
      const { samples, gaps } = mapSamples(claim, analysis.samples)
      const envelope = createFaceProducerEnvelope({
        id: `face-envelope-${randomUUID()}`,
        workspaceId: claim.workspaceId, projectId: claim.projectId,
        projectVersionId: claim.projectVersionId, operationId: claim.operationId,
        operationAttempt: claim.attempt,
        operationFenceHash: await dependencies.repository.currentFenceHash({
          operationId: claim.operationId, attempt: claim.attempt, leaseOwner, now: clock(),
        }),
        sourceArtifactId: claim.sourceArtifactId, sourceSha256: claim.sourceSha256,
        editPlanSnapshotId: claim.editPlanSnapshotId,
        editPlanSnapshotHash: claim.editPlanSnapshotHash,
        timelineDurationFrames: claim.timelineDurationFrames, timelineFps: claim.timelineFps,
        sourceFps: analysis.sourceFps, sourceTimebase: analysis.sourceTimebase,
        sourceClock: analysis.sourceClock, sourcePtsStart: analysis.sourcePtsStart,
        sourcePtsRounding: analysis.sourcePtsRounding,
        sourceWidth: analysis.sourceWidth, sourceHeight: analysis.sourceHeight,
        sourceOrientation: analysis.sourceOrientation,
        timeMap: claim.timeMap, detectorConfig: analysis.detectorConfig,
        producer: analysis.producer,
        samplePolicy: { strategy: 'fixed-interval', intervalFrames: claim.sampleIntervalFrames,
          maxSamples: MAX_SAMPLES }, samples, gaps, createdAt: clock().toISOString(),
      })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT',
        'Face producer was aborted before persistence')
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'persisting' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer lost its lease before persistence')
      }
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT',
        'Face producer was aborted before publication')
      await dependencies.repository.publish({ envelope, leaseOwner, now: clock() })
      return Object.freeze({ operationId: claim.operationId, status: 'succeeded' as const,
        envelopeId: envelope.id, envelopeHash: envelope.envelopeHash })
    } catch (error) {
      const settled = await dependencies.repository.failAttempt({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(),
        errorCode: error instanceof DomainError ? error.code : 'RENDER_EXECUTION_FAILED',
        errorMessage: 'Face producer failed',
        retryable: !(error instanceof DomainError && [
          'INVALID_ARGUMENT', 'PERSISTENCE_CONFLICT', 'ASSET_RIGHTS_BLOCKED',
          'RENDER_OUTPUT_INVALID', 'PERSISTENCE_NOT_CONFIGURED',
        ].includes(error.code)),
      })
      return Object.freeze({ operationId: claim.operationId,
        status: 'attempt-failed' as const, settled })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (deadline) clearTimeout(deadline)
      signal?.removeEventListener('abort', abortFromShutdown)
      await heartbeatInFlight
      await dependencies.materializer.cleanup(claim.operationId)
    }
  }
}
