import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { createReplayableMediaArtifactManifest } from '../domain/media-artifact.ts'
import { DomainError } from '../domain/errors.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { VerifiedMediaStorage } from './ports/media-ingest.ts'
import type { EditorialProxyRenderer } from './ports/editorial-proxy-renderer.ts'
import type { ProjectFinalExportRepository } from './ports/project-final-export-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { calculatePublicOperationRetryDelayMs, type PublicOperationWorkerOutcome } from './run-public-operation-worker.ts'

const NON_RETRYABLE_CODES = new Set([
  'INVALID_RENDER_INPUT',
  'RENDER_OUTPUT_INVALID',
  'PERSISTENCE_CONFLICT',
  'PERSISTENCE_NOT_CONFIGURED',
  'EDITORIAL_ACCEPTANCE_FAILED',
  'ASSET_RIGHTS_BLOCKED',
])

function safeFailure(error: unknown) {
  const retryable = !(error instanceof DomainError && NON_RETRYABLE_CODES.has(error.code))
  return {
    code: error instanceof DomainError ? error.code.toLowerCase() : 'final_export_failed',
    message: 'Project final export could not be completed',
    retryable,
  }
}

function resolveArtifactPath(rootValue: string, key: string): string {
  const root = resolve(rootValue)
  if (!rootValue.trim() || !isAbsolute(root) || key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Project final export artifact storage is invalid')
  }
  const candidate = join(root, ...key.split('/'))
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('PERSISTENCE_CONFLICT', 'Project final export source escaped artifact storage')
  return candidate
}

export function runNextProjectFinalExportOperationService(dependencies: {
  operations: PublicOperationRepository
  projects: ProjectFinalExportRepository
  rights: AssetRightsRepository
  artifacts: MediaArtifactPersistenceRepository
  storage: VerifiedMediaStorage
  renderer: EditorialProxyRenderer
  artifactRoot: string
  clock?: () => Date
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000
  const retryBaseDelayMs = dependencies.retryBaseDelayMs ?? 5_000
  const retryMaxDelayMs = dependencies.retryMaxDelayMs ?? 300_000
  if (
    !Number.isSafeInteger(leaseDurationMs) || !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 || leaseDurationMs <= heartbeatIntervalMs ||
    !Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs <= 0 ||
    !Number.isSafeInteger(retryMaxDelayMs) || retryMaxDelayMs < retryBaseDelayMs
  ) throw new DomainError('INVALID_PUBLIC_OPERATION', 'Final export worker lease configuration is invalid')
  const leaseWindow = (now: Date) => new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNext(leaseOwner: string): Promise<Readonly<PublicOperationWorkerOutcome> | null> {
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({
      leaseOwner,
      now: claimedAt.toISOString(),
      leaseUntil: leaseWindow(claimedAt),
      type: 'project-final-export',
    })
    if (!claimed) return null
    if (claimed.context.kind !== 'project-final-export') throw new DomainError('PERSISTENCE_CONFLICT', 'Final export worker claimed an incompatible operation')
    const { operation, context } = claimed
    const attempt = claimed.lease.attempt
    const abortController = new AbortController()
    let stopped = false
    let leaseLost = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined
    const command = (now: Date) => ({ operationId: operation.id, leaseOwner, attempt, now: now.toISOString() })
    const heartbeat = async () => {
      if (stopped || leaseLost) return false
      if (renewal) return renewal
      renewal = (async () => {
        try {
          const now = clock()
          const renewed = await dependencies.operations.heartbeat({ ...command(now), leaseUntil: leaseWindow(now) })
          if (!renewed) { leaseLost = true; abortController.abort() }
          return renewed
        } catch {
          leaseLost = true
          abortController.abort()
          return false
        } finally {
          renewal = undefined
        }
      })()
      return renewal
    }
    const scheduleHeartbeat = () => {
      if (stopped || leaseLost) return
      timer = setTimeout(async () => { await heartbeat(); scheduleHeartbeat() }, heartbeatIntervalMs)
      timer.unref?.()
    }
    const stopHeartbeat = () => { stopped = true; if (timer) clearTimeout(timer) }
    const enter = async (phase: 'rendering' | 'verifying' | 'persisting') => {
      const entered = await dependencies.operations.advancePhase({ ...command(clock()), phase })
      if (!entered) { leaseLost = true; abortController.abort(); throw new DomainError('RENDER_EXECUTION_FAILED', 'Final export lease was lost') }
    }
    const assertRights = async () => {
      const rights = await dependencies.rights.findCurrent(operation.workspaceId, context.sourceArtifactId)
      const decision = evaluateAssetUse(rights?.snapshot ?? null, {
        workspaceId: operation.workspaceId,
        use: 'rendering',
        locale: sourceLocale,
      }, clock())
      if (decision.outcome !== 'allow') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Source master rights no longer permit final export', { reasonCodes: decision.reasonCodes })
    }
    let sourceLocale = 'pt-BR'
    try {
      scheduleHeartbeat()
      const source = await dependencies.projects.readImmutableApprovedSource({
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
        projectVersionHash: context.projectVersionHash,
        editPlanSnapshotId: context.editPlanSnapshotId,
        directorRunId: context.directorRunId,
        qualitySnapshotId: context.qualitySnapshotId,
        qualitySnapshotHash: context.qualitySnapshotHash,
        sourceArtifactId: context.sourceArtifactId,
        sourceManifestId: context.sourceManifestId,
      })
      if (!source) throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', 'Immutable approved final export source disappeared')
      sourceLocale = source.locale
      const clips = source.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
      if (
        source.editPlan.movementPolicy.automaticZoom || clips.length < 1 ||
        source.editPlan.movementPolicy.protectedOpeningFrames < Math.round(source.editPlan.fps * 4) ||
        source.format !== context.outputSpec.aspectRatio ||
        Math.abs(source.editPlan.fps - context.outputSpec.fps) > 0.01
      ) throw new DomainError('INVALID_RENDER_INPUT', 'Approved EditPlan or final OutputSpec is not safe to render')
      await assertRights()
      const subtitleCues = source.editPlan.subtitleTracks.flatMap((track) => 'cues' in track ? track.cues : [])
      const transitions = 'transitions' in source.editPlan ? source.editPlan.transitions : []
      await enter('rendering')
      const rendered = await dependencies.renderer.render({
        operationId: operation.id,
        renderKind: 'final',
        sourcePath: resolveArtifactPath(dependencies.artifactRoot, source.sourceArtifactKey),
        clips,
        fps: context.outputSpec.fps,
        format: source.format,
        outputSpec: context.outputSpec,
        subtitleCues,
        transitions,
        signal: abortController.signal,
      })
      await enter('verifying')
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Final export lease was lost')
      if (rendered.probe.width !== context.outputSpec.width || rendered.probe.height !== context.outputSpec.height || Math.abs(rendered.probe.fps - context.outputSpec.fps) > 0.01) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'Final export does not match its approved OutputSpec')
      }
      await assertRights()
      await enter('persisting')
      const stored = await dependencies.storage.promoteDerived({
        workspaceId: operation.workspaceId,
        sourcePath: rendered.outputPath,
        sha256: rendered.sha256,
        extension: 'mp4',
        prefix: 'final-exports',
      })
      const toolDigest = createHash('sha256').update('apollo-v2-ffmpeg-editorial-final/1.0.0').digest('hex')
      const replayableManifest = createReplayableMediaArtifactManifest({
        artifactKey: stored.key,
        artifactSha256: stored.sha256,
        byteSize: stored.byteSize,
        mediaType: 'video',
        container: 'mp4',
        recipe: {
          id: 'editorial-final',
          version: '1.0.0',
          parameters: {
            inputHash: context.inputHash,
            projectVersionId: context.projectVersionId,
            projectVersionHash: context.projectVersionHash,
            editPlanSnapshotId: context.editPlanSnapshotId,
            directorRunId: context.directorRunId,
            qualitySnapshotId: context.qualitySnapshotId,
            qualitySnapshotHash: context.qualitySnapshotHash,
            outputSpec: context.outputSpec,
            approval: context.approval,
          },
        },
        sources: [{
          artifactKey: source.sourceArtifactKey,
          sha256: source.sourceSha256,
          role: 'source-master',
          execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } },
        }],
        probe: {
          width: rendered.probe.width,
          height: rendered.probe.height,
          duration: rendered.probe.duration,
          fps: rendered.probe.fps,
        },
      })
      const persisted = await dependencies.artifacts.persistOrReplay({
        workspaceId: operation.workspaceId,
        artifactId: context.outputArtifactId,
        manifestId: context.outputManifestId,
        lineageIds: [`lineage-${createHash('sha256').update(`${operation.workspaceId}:${context.inputHash}:final`).digest('hex')}`],
        manifest: replayableManifest.manifest,
        recipeParameters: replayableManifest.recipeParameters,
        createdAt: clock().toISOString(),
      })
      if (persisted.artifactId !== context.outputArtifactId || persisted.manifestId !== context.outputManifestId) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export artifact identity did not converge')
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Final export lease was lost')
      await dependencies.projects.attachCompletedOutput({
        workspaceId: operation.workspaceId,
        operationId: operation.id,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
        outputArtifactId: context.outputArtifactId,
        outputManifestId: context.outputManifestId,
        originalFileName: context.originalFileName,
        createdAt: clock().toISOString(),
      })
      stopHeartbeat()
      const succeeded = await dependencies.operations.succeed(command(clock()))
      if (!succeeded) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      await dependencies.renderer.cleanup(operation.id).catch(() => undefined)
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
      if (failed.operation.status === 'failed') await dependencies.projects.markExportFailed({ workspaceId: operation.workspaceId, operationId: operation.id, projectId: context.projectId })
      await dependencies.renderer.cleanup(operation.id).catch(() => undefined)
      return Object.freeze({ operationId: operation.id, status: failed.operation.status === 'retrying' ? 'retrying' as const : 'failed' as const })
    } finally {
      stopHeartbeat()
    }
  }
}
