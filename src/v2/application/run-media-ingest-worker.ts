import { createHash } from 'node:crypto'

import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { MediaIngestProcessor, MediaTranscriber, ProjectMediaRepository, VerifiedMediaStorage } from './ports/media-ingest.ts'
import type { MediaTransferRepository } from './ports/media-transfer-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { assetRightsRevision } from '../domain/asset-rights.ts'
import { DomainError } from '../domain/errors.ts'
import { createMediaArtifactManifest, createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import { probeVideo } from '../infrastructure/media/video-probe.ts'
import { setAssetRightsService } from './set-asset-rights.ts'
import { calculatePublicOperationRetryDelayMs } from './run-public-operation-worker.ts'

const NON_RETRYABLE_CODES = new Set([
  'INVALID_ARGUMENT', 'INVALID_MEDIA_ARTIFACT', 'MEDIA_UPLOAD_TRANSITION_REJECTED',
  'PERSISTENCE_CONFLICT', 'RENDER_OUTPUT_INVALID',
])

function safeFailure(error: unknown) {
  return {
    code: error instanceof DomainError ? error.code.toLowerCase() : 'media_ingest_failed',
    message: 'Media ingest could not be completed',
    retryable: !(error instanceof DomainError && NON_RETRYABLE_CODES.has(error.code)),
  }
}

function containerFromKey(key: string): string {
  const extension = key.split('.').at(-1)?.toLowerCase()
  if (!extension || !/^[a-z0-9]{2,8}$/.test(extension)) throw new DomainError('INVALID_MEDIA_ARTIFACT', 'Artifact key has no supported container')
  return extension
}

export function runNextMediaIngestOperationService(dependencies: {
  operations: PublicOperationRepository
  uploads: MediaTransferRepository
  artifacts: MediaArtifactPersistenceRepository
  projectMedia: ProjectMediaRepository
  storage: VerifiedMediaStorage
  processor: MediaIngestProcessor
  transcriber: MediaTranscriber
  rights: AssetRightsRepository
  clock?: () => Date
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 60_000
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000
  const retryBaseDelayMs = dependencies.retryBaseDelayMs ?? 5_000
  const retryMaxDelayMs = dependencies.retryMaxDelayMs ?? 300_000
  if (!Number.isSafeInteger(leaseDurationMs) || !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || leaseDurationMs <= heartbeatIntervalMs) {
    throw new DomainError('INVALID_PUBLIC_OPERATION', 'Ingest worker lease configuration is invalid')
  }
  const leaseUntil = (now: Date) => new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNext(leaseOwner: string) {
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({
      leaseOwner, now: claimedAt.toISOString(), leaseUntil: leaseUntil(claimedAt), type: 'media-ingest',
    })
    if (!claimed) return null
    if (claimed.context.kind !== 'media-ingest') throw new DomainError('PERSISTENCE_CONFLICT', 'Ingest worker claimed an incompatible operation')
    const { operation, context } = claimed
    const attempt = claimed.lease.attempt
    const abortController = new AbortController()
    let leaseLost = false
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewing: Promise<boolean> | undefined
    const command = (now: Date) => ({ operationId: operation.id, leaseOwner, attempt, now: now.toISOString() })
    const heartbeat = async () => {
      if (leaseLost || stopped) return false
      if (renewing) return renewing
      renewing = (async () => {
        try {
          const now = clock()
          const renewed = await dependencies.operations.heartbeat({ ...command(now), leaseUntil: leaseUntil(now) })
          if (!renewed) { leaseLost = true; abortController.abort() }
          return renewed
        } catch { leaseLost = true; abortController.abort(); return false }
        finally { renewing = undefined }
      })()
      return renewing
    }
    const scheduleHeartbeat = () => {
      if (stopped || leaseLost) return
      timer = setTimeout(async () => { await heartbeat(); scheduleHeartbeat() }, heartbeatIntervalMs)
      timer.unref?.()
    }
    const stopHeartbeat = () => { stopped = true; if (timer) clearTimeout(timer) }
    const enter = async (phase: 'probing' | 'normalizing' | 'transcribing' | 'verifying' | 'persisting') => {
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Ingest lease was lost')
      const entered = await dependencies.operations.advancePhase({ ...command(clock()), phase })
      if (!entered) { leaseLost = true; abortController.abort(); throw new DomainError('RENDER_EXECUTION_FAILED', 'Ingest lease was lost') }
    }

    try {
      scheduleHeartbeat()
      const upload = await dependencies.uploads.findUpload({ workspaceId: operation.workspaceId, clientId: operation.clientId, uploadId: context.uploadId })
      if (!upload || upload.status !== 'verified' || upload.kind !== 'video' || upload.projectId !== context.projectId || upload.fileName !== context.originalFileName) {
        throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Verified project video upload is no longer available')
      }
      const parts = await dependencies.uploads.listUploadParts({ workspaceId: operation.workspaceId, clientId: operation.clientId, uploadId: context.uploadId })
      const master = await dependencies.storage.promoteMaster(upload, parts)
      const workspaceNamespace = createHash('sha256').update(operation.workspaceId).digest('hex').slice(0, 12)

      await enter('probing')
      const sourceProbe = await probeVideo(master.path, { signal: abortController.signal })
      const now = clock().toISOString()
      const sourceManifest = createMediaArtifactManifest({
        artifactKey: master.key, artifactSha256: master.sha256, byteSize: master.byteSize,
        mediaType: 'video', container: containerFromKey(master.key),
        recipe: { id: 'direct-upload', version: '1.0.0', parameters: { mimeType: upload.mimeType } },
      })
      const sourcePersisted = await dependencies.artifacts.persistOrReplay({
        workspaceId: operation.workspaceId, artifactId: context.sourceArtifactId,
        manifestId: context.sourceManifestId, lineageIds: [], manifest: sourceManifest, createdAt: now,
      })
      if (sourcePersisted.artifactId !== context.sourceArtifactId || sourcePersisted.manifestId !== context.sourceManifestId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Source artifact identity did not converge')
      }
      const writeRights = async (artifactId: string) => {
        const current = await dependencies.rights.findCurrent(operation.workspaceId, artifactId)
        if (current?.snapshot?.status === 'approved') return current
        return setAssetRightsService({
          repository: dependencies.rights, clock, createId: () => `rights-${artifactId}`,
        })({
          workspaceId: operation.workspaceId, artifactId, baseRevision: assetRightsRevision(artifactId, 0),
          draft: {
            owner: 'Authenticated workspace uploader', license: 'workspace-authorized', status: 'approved',
            allowedUses: ['distribution', 'editing', 'rendering', 'transcription'], prohibitedUses: [],
            consent: { status: 'not-required', allowedUses: [] },
            sourceNote: `Rights confirmed during upload ${upload.id}`,
          },
          actor: { type: 'api-client', id: operation.clientId },
        })
      }
      await writeRights(context.sourceArtifactId)

      await enter('normalizing')
      const normalized = await dependencies.processor.normalize({ sourcePath: master.path, operationId: operation.id, signal: abortController.signal })
      const proxyStored = await dependencies.storage.promoteDerived({
        workspaceId: operation.workspaceId, sourcePath: normalized.proxyPath, sha256: normalized.proxySha256,
        extension: 'mp4', prefix: 'editing-proxies',
      })
      const proxyArtifactId = `artifact-${workspaceNamespace}-${proxyStored.sha256}`
      const toolDigest = createHash('sha256').update('apollo-v2-ffmpeg-editing-proxy/1.0.0').digest('hex')
      const proxyManifest = createMediaArtifactManifestV2({
        artifactKey: proxyStored.key, artifactSha256: proxyStored.sha256, byteSize: proxyStored.byteSize,
        mediaType: 'video', container: 'mp4',
        recipe: { id: 'editing-proxy', version: '1.0.0', parameters: { maxWidth: 1280, videoCodec: 'h264', audioCodec: 'aac' } },
        sources: [{
          artifactKey: sourceManifest.artifact.artifactKey, sha256: sourceManifest.artifact.sha256, role: 'source-master',
          execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } },
        }],
        probe: { width: normalized.probe.width, height: normalized.probe.height, duration: normalized.probe.duration, fps: normalized.probe.fps },
      })
      const proxyManifestId = `manifest-proxy-${workspaceNamespace}-${proxyManifest.manifestHash}`
      const proxyPersisted = await dependencies.artifacts.persistOrReplay({
        workspaceId: operation.workspaceId, artifactId: proxyArtifactId, manifestId: proxyManifestId,
        lineageIds: [`lineage-${workspaceNamespace}-${proxyManifest.manifestHash}`], manifest: proxyManifest, createdAt: clock().toISOString(),
      })
      if (proxyPersisted.artifactId !== proxyArtifactId || proxyPersisted.manifestId !== proxyManifestId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy artifact identity did not converge')
      }
      await writeRights(proxyArtifactId)

      await enter('transcribing')
      const project = await dependencies.projectMedia.readProject({ workspaceId: operation.workspaceId, projectId: context.projectId })
      if (!project) throw new DomainError('PERSISTENCE_CONFLICT', 'Ingest project no longer exists')
      const transcript = await dependencies.transcriber.transcribe({ audioPath: normalized.audioPath, language: project.locale, signal: abortController.signal })
      const transcriptId = `transcript-${workspaceNamespace}-${transcript.transcriptHash}`

      await enter('verifying')
      const lastWordEnd = transcript.words.at(-1)?.end ?? transcript.segments.at(-1)?.end ?? 0
      if (lastWordEnd <= 0 || lastWordEnd > sourceProbe.duration + 2 || Math.abs(normalized.probe.duration - sourceProbe.duration) > 1) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'Ingest derivatives failed duration alignment verification')
      }

      await enter('persisting')
      await dependencies.projectMedia.persistCompletedIngest({
        workspaceId: operation.workspaceId, projectId: context.projectId, uploadId: context.uploadId,
        originalFileName: context.originalFileName, sourceArtifactId: context.sourceArtifactId,
        sourceManifestId: context.sourceManifestId, proxyArtifactId, proxyManifestId, transcriptId,
        transcript, sourceManifest, proxyManifest, createdAt: clock().toISOString(),
      })
      stopHeartbeat()
      const succeeded = await dependencies.operations.succeed(command(clock()))
      if (!succeeded) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      await dependencies.processor.cleanup(operation.id).catch(() => undefined)
      return Object.freeze({ operationId: operation.id, status: 'succeeded' as const })
    } catch (error) {
      stopHeartbeat()
      if (leaseLost) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      const failedAt = clock()
      const failure = safeFailure(error)
      const nextAttemptAt = failure.retryable && attempt < operation.maxAttempts
        ? new Date(failedAt.getTime() + calculatePublicOperationRetryDelayMs({ attempt, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs })).toISOString()
        : undefined
      const failed = await dependencies.operations.failOrRetry({ ...command(failedAt), error: failure, ...(nextAttemptAt ? { nextAttemptAt } : {}) })
      if (!failed) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      if (failed.operation.status === 'failed') await dependencies.projectMedia.markIngestFailed({ workspaceId: operation.workspaceId, projectId: context.projectId })
      return Object.freeze({ operationId: operation.id, status: failed.operation.status === 'retrying' ? 'retrying' as const : 'failed' as const })
    } finally {
      stopHeartbeat()
    }
  }
}
