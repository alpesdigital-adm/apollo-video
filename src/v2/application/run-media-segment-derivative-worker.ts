import type { MediaSegmentRepository } from './ports/media-segment-repository.ts'
import type { MediaLibraryRepository } from './ports/media-library-repository.ts'
import type { MediaSegmentDerivativeJobRepository } from './ports/media-segment-derivative-job-repository.ts'
import { DomainError } from '../domain/errors.ts'

const NON_RETRYABLE = new Set(['INVALID_ARGUMENT', 'ASSET_RIGHTS_BLOCKED', 'PERSISTENCE_CONFLICT', 'RENDER_OUTPUT_INVALID', 'MEDIA_ARTIFACT_NOT_FOUND'])

export function runNextMediaSegmentDerivativeJobService(dependencies: {
  jobs: MediaSegmentDerivativeJobRepository
  segments: MediaSegmentRepository
  library: MediaLibraryRepository
  materialize: ReturnType<typeof import('./materialize-media-segment.ts').materializeMediaSegmentDerivativeService>
  clock?: () => Date
  heartbeatIntervalMs?: number
  leaseDurationMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const interval = dependencies.heartbeatIntervalMs ?? 2_000
  const leaseDuration = dependencies.leaseDurationMs ?? 15_000
  if (interval < 100 || leaseDuration <= interval * 2) throw new DomainError('INVALID_ARGUMENT', 'Derivative worker lease settings are invalid')
  return async (owner: string, signal?: AbortSignal) => {
    if (signal?.aborted) return null
    const now = clock()
    const job = await dependencies.jobs.claim(owner, now, new Date(now.getTime() + leaseDuration))
    if (!job) return null
    const abort = new AbortController()
    const relay = () => abort.abort()
    signal?.addEventListener('abort', relay, { once: true })
    const deadlineMs = new Date(job.deadlineAt).getTime() - now.getTime()
    const deadlineTimer = setTimeout(relay, Math.max(0, deadlineMs))
    let heartbeatInFlight: Promise<void> | undefined
    const timer = setInterval(() => {
      if (heartbeatInFlight || abort.signal.aborted) return
      heartbeatInFlight = (async () => { try {
        const valid = await dependencies.jobs.heartbeat(job.id, owner, job.attempt, clock(), new Date(clock().getTime() + leaseDuration))
        if (!valid) abort.abort()
      } catch { abort.abort() }
      finally { heartbeatInFlight = undefined }
      })()
    }, interval)
    try {
      const [segment, item] = await Promise.all([dependencies.segments.find(job.workspaceId, job.segmentId), dependencies.library.findById(job.workspaceId, job.segmentId, clock())])
      if (!segment || segment.segmentHash !== job.segmentHash || !item || item.kind !== 'segment' || item.status !== 'usable' || item.rights.status !== 'eligible' || item.rights.snapshotId !== job.rightsSnapshotId) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Derivative source or rights changed before execution')
      const source = await dependencies.segments.readSource(job.workspaceId, segment.parentAssetId)
      if (!source || source.sha256 !== job.sourceSha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Derivative source hash changed')
      if (abort.signal.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Derivative job stopped before extraction')
      const result = await dependencies.materialize({ workspaceId: job.workspaceId, segmentId: job.segmentId, consumerKey: job.consumerKey, requiresPhysicalDerivative: true, signal: abort.signal, publish: (prepare) => dependencies.jobs.publish(job.id, owner, job.attempt, prepare, abort.signal) })
      if (!('outputArtifactId' in result) || !('outputManifestId' in result)) throw new DomainError('PERSISTENCE_CONFLICT', 'Derivative worker did not produce an artifact')
      return Object.freeze({ jobId: job.id, status: 'succeeded' as const, outputArtifactId: result.outputArtifactId, outputManifestId: result.outputManifestId })
    } catch (error) {
      const code = clock().getTime() >= new Date(job.deadlineAt).getTime() ? 'RENDER_DEADLINE_EXCEEDED' : error instanceof DomainError ? error.code : 'RENDER_EXECUTION_FAILED'
      await dependencies.jobs.failOrRetry(job.id, owner, job.attempt, code, !NON_RETRYABLE.has(code) && !abort.signal.aborted, clock())
      return Object.freeze({ jobId: job.id, status: abort.signal.aborted ? 'stopped' as const : 'failed' as const, errorCode: code })
    } finally {
      clearInterval(timer); clearTimeout(deadlineTimer); signal?.removeEventListener('abort', relay)
      await heartbeatInFlight
    }
  }
}
