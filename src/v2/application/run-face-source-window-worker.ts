import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { DomainError } from '../domain/errors.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, faceWindowFrames } from '../domain/face-evidence-policy.ts'
import { createFaceProducerEnvelopeV3, type FaceSampleV3 } from '../domain/face-producer-envelope-v3.ts'
import type { FaceWindowAnalyzer } from './ports/face-window-worker.ts'
import type { FaceSourceWindowClaim, FaceSourceWindowWorkerRepository } from './ports/face-source-window-worker.ts'
import type { ArtifactSourceMaterializer } from './ports/media-ingest.ts'

const MAX_SAMPLES = FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow

function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }

/** Samples and gaps that exactly cover [start, end): every frame not sampled is an explicit NOT_SAMPLED gap. */
function windowCoverage(claim: FaceSourceWindowClaim, samples: readonly FaceSampleV3[]) {
  const { startSourceFrame: start, endSourceFrame: end } = claim.window
  const gaps: Array<{ startSourceFrame: number; endSourceFrame: number; reasonCode: string }> = []
  let cursor = start
  for (const sample of samples) {
    if (sample.sourceFrame > cursor) gaps.push({ startSourceFrame: cursor, endSourceFrame: sample.sourceFrame, reasonCode: 'NOT_SAMPLED' })
    cursor = sample.sourceFrame + 1
  }
  if (cursor < end) gaps.push({ startSourceFrame: cursor, endSourceFrame: end, reasonCode: 'NOT_SAMPLED' })
  return gaps
}

/** Validates the claim against what this worker can observe: one bounded window of the source's own frames. */
function validateClaim(claim: FaceSourceWindowClaim) {
  const interval = claim.sampleIntervalFrames
  const { startSourceFrame: start, endSourceFrame: end } = claim.window
  if (!Number.isSafeInteger(claim.sourceFps) || claim.sourceFps < 1) invalid('Face source window needs an integer source frame rate')
  if (!Number.isSafeInteger(interval) || interval < 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
      end <= start || end - start > faceWindowFrames(interval)) invalid('Face source window is outside its bounds')
  const firstSample = Math.ceil(start / interval) * interval
  const requested = firstSample < end ? Math.floor((end - 1 - firstSample) / interval) + 1 : 0
  if (requested < 1 || requested > MAX_SAMPLES) invalid('Face source window requires between one and sixty sampled frames')
  return { interval }
}

/**
 * Runs one bounded window observation of a SOURCE and persists only sampled, unverified face candidates (the V9 source profile, W65b).
 * It is the timeline-free twin of `runNextFaceWindowOperationService`: the window is the claim's own source frames, so nothing is offset
 * through a clip and the sealed envelope names no project, version or time map.
 */
export function runNextFaceSourceWindowOperationService(dependencies: {
  repository: FaceSourceWindowWorkerRepository
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
      const { interval } = validateClaim(claim)
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
      // The analyzer's `timelineFps` is the frame rate the claim EXPECTS of the source; it refuses a source that measures differently.
      const analysis = await dependencies.analyzer.analyze({
        sourcePath: materialized.path, expectedSourceSha256: claim.sourceSha256, workDirectory: dirname(materialized.path),
        sourceInFrame: claim.window.startSourceFrame, sourceOutFrame: claim.window.endSourceFrame,
        sampleIntervalFrames: interval, maxSamples: MAX_SAMPLES, timelineFps: { num: claim.sourceFps, den: 1 }, signal: controller.signal })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Face producer was aborted before verification')
      await phase('verifying')
      const samples: FaceSampleV3[] = analysis.samples.map((sample) => ({ ...sample }))
      const envelope = createFaceProducerEnvelopeV3({
        id: `face-source-envelope-${randomUUID()}`, workspaceId: claim.workspaceId,
        operationId: claim.operationId, operationAttempt: claim.attempt,
        operationFenceHash: await dependencies.repository.currentFenceHash({ operationId: claim.operationId, attempt: claim.attempt, leaseOwner, now: clock() }),
        sourceArtifactId: claim.sourceArtifactId, sourceSha256: claim.sourceSha256,
        sourceFps: analysis.sourceFps, sourceTimebase: analysis.sourceTimebase, sourceClock: analysis.sourceClock,
        sourcePtsStart: analysis.sourcePtsStart, sourcePtsRounding: analysis.sourcePtsRounding,
        sourceWidth: analysis.sourceWidth, sourceHeight: analysis.sourceHeight, sourceOrientation: analysis.sourceOrientation,
        window: claim.window, policyId: FACE_EVIDENCE_POLICY.id, policySha256: FACE_EVIDENCE_POLICY_SHA256,
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
