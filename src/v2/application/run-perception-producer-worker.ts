import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

import type { ArtifactSourceMaterializer } from './ports/media-ingest.ts'
import type { OcrVideoAnalyzer, PerceptionProducerWorkerRepository } from './ports/perception-producer-worker.ts'
import { createPerceptionProducerEnvelope } from '../domain/perception-producer-envelope.ts'
import { DomainError } from '../domain/errors.ts'

function timelineForSourceFrame(frame: number, ranges: readonly {
  sourceInFrame: number; sourceOutFrame: number; timelineInFrame: number; timelineOutFrame: number; rate: number
}[], sourceFps: Readonly<{ num: number; den: number }>, timelineFps: Readonly<{ num: number; den: number }>) {
  if (sourceFps.num * timelineFps.den !== timelineFps.num * sourceFps.den) {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR source and timeline fps differ; frame mapping is unsupported')
  }
  return ranges.flatMap((range) => {
    if (frame < range.sourceInFrame || frame >= range.sourceOutFrame) return []
    const elapsedSeconds = (frame - range.sourceInFrame) * sourceFps.den / sourceFps.num / range.rate
    const mapped = range.timelineInFrame + Math.round(elapsedSeconds * timelineFps.num / timelineFps.den)
    return mapped < range.timelineOutFrame ? [mapped] : []
  })
}

function coverageGaps(frames: readonly number[], durationFrames: number) {
  const gaps: Array<{ startTimelineFrame: number; endTimelineFrame: number; reasonCode: string }> = []
  let cursor = 0
  for (const frame of frames) {
    if (frame > cursor) gaps.push({ startTimelineFrame: cursor, endTimelineFrame: frame, reasonCode: 'NOT_SAMPLED' })
    cursor = frame + 1
  }
  if (cursor < durationFrames) gaps.push({ startTimelineFrame: cursor,
    endTimelineFrame: durationFrames, reasonCode: 'NOT_SAMPLED' })
  return gaps
}

/** OCR producer only. The resulting envelope always leaves face safety unknown. */
export function runNextPerceptionProducerOperationService(dependencies: {
  repository: PerceptionProducerWorkerRepository
  materializer: ArtifactSourceMaterializer
  adapter: OcrVideoAnalyzer
  clock?: () => Date
  leaseMs?: number
  heartbeatMs?: number
  deadlineMs?: number
  createScratch?: () => Promise<string>
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseMs = dependencies.leaseMs ?? 120_000
  const heartbeatMs = dependencies.heartbeatMs ?? 10_000
  const deadlineMs = dependencies.deadlineMs ?? 300_000
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
    throw new DomainError('INVALID_ARGUMENT', 'Perception worker deadline is invalid')
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs >= leaseMs / 2) {
    throw new DomainError('INVALID_ARGUMENT', 'Perception worker heartbeat must be shorter than half the lease')
  }
  return async (leaseOwner: string, signal?: AbortSignal) => {
    if (signal?.aborted) return null
    const claim = await dependencies.repository.claimNext({ leaseOwner, now: clock(), leaseMs })
    if (!claim) return null
    const controller = new AbortController()
    const abortFromShutdown = () => controller.abort()
    signal?.addEventListener('abort', abortFromShutdown, { once: true })
    if (signal?.aborted) controller.abort()
    let scratch: string | undefined
    let heartbeatInFlight: Promise<void> = Promise.resolve()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      scratch = await (dependencies.createScratch ?? (() => mkdtemp(resolve(tmpdir(), 'apollo-perception-'))))()
      heartbeat = setInterval(() => {
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          if (!await dependencies.repository.heartbeat({ operationId: claim.operationId,
            attempt: claim.attempt, leaseOwner, now: clock(), leaseMs })) controller.abort()
        }).catch(() => controller.abort())
      }, heartbeatMs)
      deadline = setTimeout(() => controller.abort(), deadlineMs)
      const materialized = await dependencies.materializer.materialize({
        operationId: claim.operationId, artifactKey: claim.artifactKey,
        sha256: claim.sourceSha256, byteSize: claim.sourceByteSize, signal: controller.signal,
      })
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'transcribing' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Producer lease was lost before OCR')
      }
      const analysis = await dependencies.adapter.analyze({
        sourcePath: materialized.path, expectedSourceSha256: claim.sourceSha256,
        workDirectory: scratch, sampleIntervalFrames: claim.sampleIntervalFrames,
        maxSamples: 1000, timelineFps: claim.timelineFps, signal: controller.signal,
      })
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'verifying' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Producer lease was lost before verification')
      }
      const samples = analysis.samples.flatMap((sample) =>
        timelineForSourceFrame(sample.sourceFrame, claim.timeMap, analysis.sourceFps, claim.timelineFps).map((timelineFrame) => ({
          ...sample, timelineFrame,
        }))).sort((left, right) => left.timelineFrame - right.timelineFrame)
      const gaps = coverageGaps(samples.map((sample) => sample.timelineFrame), claim.timelineDurationFrames)
      const envelope = createPerceptionProducerEnvelope({
        id: `perception-envelope-${randomUUID()}`,
        workspaceId: claim.workspaceId, projectId: claim.projectId,
        projectVersionId: claim.projectVersionId, operationId: claim.operationId,
        operationAttempt: claim.attempt,
        operationFenceHash: await dependencies.repository.currentFenceHash({
          operationId: claim.operationId, attempt: claim.attempt, leaseOwner, now: clock(),
        }),
        sourceArtifactId: claim.sourceArtifactId, sourceSha256: claim.sourceSha256,
        editPlanSnapshotId: claim.editPlanSnapshotId,
        editPlanSnapshotHash: claim.editPlanSnapshotHash,
        timeMap: claim.timeMap, timelineDurationFrames: claim.timelineDurationFrames,
        sourceTimebase: analysis.sourceTimebase, sourceFps: analysis.sourceFps,
        timelineFps: claim.timelineFps, sourcePtsStart: analysis.sourcePtsStart,
        sourcePtsRounding: 'nearest', sourceClock: analysis.sourceClock,
        modality: 'ocr', producer: { ...analysis.producer,
          ffmpegSha256: analysis.runtime.ffmpegSha256,
          ffprobeSha256: analysis.runtime.ffprobeSha256 },
        samplePolicy: { strategy: 'fixed-interval', intervalFrames: claim.sampleIntervalFrames,
          maxSamples: 1000 },
        samples, gaps, createdAt: clock().toISOString(),
      })
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'persisting' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Producer lease was lost before persistence')
      }
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT', 'Producer was aborted before publication')
      await dependencies.repository.publish({ envelope, leaseOwner, now: clock() })
      return Object.freeze({ operationId: claim.operationId, status: 'succeeded' as const,
        envelopeId: envelope.id, envelopeHash: envelope.envelopeHash })
    } catch (error) {
      const settled = await dependencies.repository.failAttempt({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(),
        errorCode: error instanceof DomainError ? error.code : 'RENDER_EXECUTION_FAILED',
        errorMessage: 'Perception OCR producer failed',
        retryable: !(error instanceof DomainError && [
          'INVALID_ARGUMENT', 'PERSISTENCE_CONFLICT', 'ASSET_RIGHTS_BLOCKED',
          'RENDER_OUTPUT_INVALID', 'PERSISTENCE_NOT_CONFIGURED',
        ].includes(error.code)),
      })
      return Object.freeze({ operationId: claim.operationId, status: 'attempt-failed' as const, settled })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (deadline) clearTimeout(deadline)
      signal?.removeEventListener('abort', abortFromShutdown)
      await heartbeatInFlight
      try { await dependencies.materializer.cleanup(claim.operationId) }
      finally {
        const canonicalScratch = scratch ? await realpath(scratch).catch(() => null) : null
        if (canonicalScratch && isAbsolute(canonicalScratch)) {
          const offset = relative(resolve(tmpdir()), canonicalScratch)
          if (offset && !offset.startsWith('..') && !isAbsolute(offset)) {
            await rm(canonicalScratch, { recursive: true, force: true })
          }
        }
      }
    }
  }
}
