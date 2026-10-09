import { randomUUID } from 'node:crypto'

import type { ArtifactSourceMaterializer } from './ports/media-ingest.ts'
import type { VisualTemporalAnalyzer } from './ports/visual-temporal-analyzer.ts'
import type { TemporalProducerWorkerRepository } from './ports/temporal-producer-worker.ts'
import { createTemporalProducerEnvelope } from '../domain/temporal-producer-envelope.ts'
import { DomainError } from '../domain/errors.ts'

/** Publishes bounded raw temporal measurements; never authorizes face, crop or hard-cut decisions. */
export function runNextTemporalProducerOperationService(dependencies: {
  repository: TemporalProducerWorkerRepository
  materializer: ArtifactSourceMaterializer
  analyzer: VisualTemporalAnalyzer
  clock?: () => Date
  leaseMs?: number; heartbeatMs?: number; deadlineMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseMs = dependencies.leaseMs ?? 120_000
  const heartbeatMs = dependencies.heartbeatMs ?? 10_000
  const deadlineMs = dependencies.deadlineMs ?? 120_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 2_000 || leaseMs > 300_000 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs >= leaseMs / 2) {
    throw new DomainError('INVALID_ARGUMENT', 'Temporal worker lease, deadline or heartbeat is invalid')
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
      if (claim.timelineDurationFrames < 2 || claim.timelineDurationFrames > 300 ||
          claim.timeMap.length === 0 || claim.timeMap.some((range) =>
            range.rate !== 1 || range.sourceOutFrame > 300)) {
        throw new DomainError('INVALID_ARGUMENT',
          'Temporal producer supports only unit-rate, at-most-300-frame inputs')
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
        'Temporal producer was aborted before analysis')
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'analyzing' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal producer lost its lease before analysis')
      }
      const analysis = await dependencies.analyzer.analyze({
        sourcePath: materialized.path, expectedSourceSha256: claim.sourceSha256,
        signal: controller.signal,
      })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT',
        'Temporal producer was aborted before verification')
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'verifying' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal producer lost its lease before verification')
      }
      const envelope = createTemporalProducerEnvelope({
        id: `temporal-envelope-${randomUUID()}`,
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
        timelineFps: claim.timelineFps, analysis, createdAt: clock().toISOString(),
      })
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT',
        'Temporal producer was aborted before persistence')
      if (!await dependencies.repository.advancePhase({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(), phase: 'persisting' })) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Temporal producer lost its lease before persistence')
      }
      if (controller.signal.aborted) throw new DomainError('PERSISTENCE_CONFLICT',
        'Temporal producer was aborted before publication')
      await dependencies.repository.publish({ envelope, leaseOwner, now: clock() })
      return Object.freeze({ operationId: claim.operationId, status: 'succeeded' as const,
        envelopeId: envelope.id, envelopeHash: envelope.envelopeHash })
    } catch (error) {
      const settled = await dependencies.repository.failAttempt({ operationId: claim.operationId,
        attempt: claim.attempt, leaseOwner, now: clock(),
        errorCode: error instanceof DomainError ? error.code : 'RENDER_EXECUTION_FAILED',
        errorMessage: 'Temporal producer failed',
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
