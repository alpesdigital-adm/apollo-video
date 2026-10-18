import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { DomainError } from '../domain/errors.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, faceWindowFrames } from '../domain/face-evidence-policy.ts'
import { createFaceProducerEnvelopeV2, type FaceSampleV2 } from '../domain/face-producer-envelope-v2.ts'
import type { ArtifactSourceMaterializer } from './ports/media-ingest.ts'
import type { FaceWindowAnalyzer, FaceWindowClaim, FaceWindowWorkerRepository } from './ports/face-window-worker.ts'

const MAX_SAMPLES = FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow

function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }

/** Samples and gaps that exactly cover [start, end): every frame not sampled is an explicit NOT_SAMPLED gap. */
function windowCoverage(claim: FaceWindowClaim, samples: readonly FaceSampleV2[]) {
  const { startTimelineFrame: start, endTimelineFrame: end } = claim.window
  const gaps: Array<{ startTimelineFrame: number; endTimelineFrame: number; reasonCode: string }> = []
  let cursor = start
  for (const sample of samples) {
    if (sample.timelineFrame > cursor) gaps.push({ startTimelineFrame: cursor, endTimelineFrame: sample.timelineFrame, reasonCode: 'NOT_SAMPLED' })
    cursor = sample.timelineFrame + 1
  }
  if (cursor < end) gaps.push({ startTimelineFrame: cursor, endTimelineFrame: end, reasonCode: 'NOT_SAMPLED' })
  return gaps
}

/** Validates the claim against what this worker can observe: one unit-rate clip, one bounded window. */
function validateClaim(claim: FaceWindowClaim) {
  const range = claim.timeMap[0]
  const interval = claim.sampleIntervalFrames
  const { startTimelineFrame: start, endTimelineFrame: end } = claim.window
  if (claim.timeMap.length !== 1 || !range || range.rate !== 1 || range.timelineInFrame !== 0 ||
      range.timelineOutFrame !== claim.timelineDurationFrames ||
      range.sourceOutFrame - range.sourceInFrame !== claim.timelineDurationFrames) {
    invalid('Face window supports one unit-rate source clip covering the timeline')
  }
  if (!Number.isSafeInteger(interval) || interval < 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
      end <= start || end > claim.timelineDurationFrames || end - start > faceWindowFrames(interval)) invalid('Face window is outside its bounds')
  const firstSample = Math.ceil((range.sourceInFrame + start) / interval) * interval
  const requested = firstSample < range.sourceInFrame + end ? Math.floor((range.sourceInFrame + end - 1 - firstSample) / interval) + 1 : 0
  if (requested < 1 || requested > MAX_SAMPLES) invalid('Face window requires between one and sixty sampled frames')
  return { range, interval }
}

/** Runs one bounded window observation and persists only sampled, unverified face candidates (the V9 profile). */
export function runNextFaceWindowOperationService(dependencies: {
  repository: FaceWindowWorkerRepository
  materializer: ArtifactSourceMaterializer
  analyzer: FaceWindowAnalyzer
  clock?: () => Date
  leaseMs?: number; heartbeatMs?: number; deadlineMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseMs = dependencies.leaseMs ?? 120_000
  const heartbeatMs = dependencies.heartbeatMs ?? 10_000
  const deadlineMs = dependencies.deadlineMs ?? 180_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 2_000 || leaseMs > 300_000 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs >= leaseMs / 2 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
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
      const { range, interval } = validateClaim(claim)
      heartbeat = setInterval(() => {
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          if (!await dependencies.repository.heartbeat({ operationId: claim.operationId, attempt: claim.attempt, leaseOwner, now: clock(), leaseMs })) controller.abort()
        }).catch(() => controller.abort())
      }, heartbeatMs)
      deadline = setTimeout(() => controller.abort(), deadlineMs)
      const materialized = await dependencies.materializer.materialize({ operationId: claim.operationId, artifactKey: claim.artifactKey,
        sha256: claim.sourceSha256, byteSize: claim.sourceByteSize, signal: controller.signal })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer was aborted before analysis')
      const phase = async (name: 'analyzing' | 'verifying' | 'persisting') => {
        if (!await dependencies.repository.advancePhase({ operationId: claim.operationId, attempt: claim.attempt, leaseOwner, now: clock(), phase: name })) {
          throw new DomainError('PERSISTENCE_CONFLICT', `Face producer lost its lease before ${name}`)
        }
      }
      await phase('analyzing')
      const analysis = await dependencies.analyzer.analyze({
        sourcePath: materialized.path, expectedSourceSha256: claim.sourceSha256, workDirectory: dirname(materialized.path),
        sourceInFrame: range.sourceInFrame + claim.window.startTimelineFrame, sourceOutFrame: range.sourceInFrame + claim.window.endTimelineFrame,
        sampleIntervalFrames: interval, maxSamples: MAX_SAMPLES, timelineFps: claim.timelineFps, signal: controller.signal })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer was aborted before verification')
      await phase('verifying')
      const samples: FaceSampleV2[] = analysis.samples.map((sample) => ({ ...sample,
        timelineFrame: range.timelineInFrame + sample.sourceFrame - range.sourceInFrame }))
      const envelope = createFaceProducerEnvelopeV2({
        id: `face-envelope-${randomUUID()}`, workspaceId: claim.workspaceId, projectId: claim.projectId,
        projectVersionId: claim.projectVersionId, operationId: claim.operationId, operationAttempt: claim.attempt,
        operationFenceHash: await dependencies.repository.currentFenceHash({ operationId: claim.operationId, attempt: claim.attempt, leaseOwner, now: clock() }),
        sourceArtifactId: claim.sourceArtifactId, sourceSha256: claim.sourceSha256,
        editPlanSnapshotId: claim.editPlanSnapshotId, editPlanSnapshotHash: claim.editPlanSnapshotHash,
        timelineDurationFrames: claim.timelineDurationFrames, timelineFps: claim.timelineFps,
        sourceFps: analysis.sourceFps, sourceTimebase: analysis.sourceTimebase, sourceClock: analysis.sourceClock,
        sourcePtsStart: analysis.sourcePtsStart, sourcePtsRounding: analysis.sourcePtsRounding,
        sourceWidth: analysis.sourceWidth, sourceHeight: analysis.sourceHeight, sourceOrientation: analysis.sourceOrientation,
        timeMap: claim.timeMap, window: claim.window, policyId: FACE_EVIDENCE_POLICY.id, policySha256: FACE_EVIDENCE_POLICY_SHA256,
        detectorConfig: analysis.detectorConfig, producer: analysis.producer,
        samplePolicy: { strategy: 'fixed-interval', intervalFrames: interval, maxSamples: MAX_SAMPLES },
        samples, gaps: windowCoverage(claim, samples), createdAt: clock().toISOString(),
      })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer was aborted before persistence')
      await phase('persisting')
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer was aborted before publication')
      await dependencies.repository.publish({ envelope, rawOutputs: analysis.rawOutputs, leaseOwner, now: clock() })
      return Object.freeze({ operationId: claim.operationId, status: 'succeeded' as const, envelopeId: envelope.id, envelopeHash: envelope.envelopeHash })
    } catch (error) {
      const settled = await dependencies.repository.failAttempt({ operationId: claim.operationId, attempt: claim.attempt, leaseOwner, now: clock(),
        errorCode: error instanceof DomainError ? error.code : 'RENDER_EXECUTION_FAILED', errorMessage: 'Face producer failed',
        retryable: !(error instanceof DomainError && ['INVALID_ARGUMENT', 'PERSISTENCE_CONFLICT', 'ASSET_RIGHTS_BLOCKED', 'RENDER_OUTPUT_INVALID', 'PERSISTENCE_NOT_CONFIGURED'].includes(error.code)) })
      return Object.freeze({ operationId: claim.operationId, status: 'attempt-failed' as const, settled })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (deadline) clearTimeout(deadline)
      signal?.removeEventListener('abort', abortFromShutdown)
      await heartbeatInFlight
      await dependencies.materializer.cleanup(claim.operationId)
    }
  }
}
