import { createHash } from 'node:crypto'

import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import { DomainError } from '../domain/errors.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import { readOutputFormatPreset } from '../domain/output-format-registry.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import { createRenderPlacementPlan, validateRenderPlacementPlan, type RenderPlacementRequestV1 } from '../domain/render-placement-plan.ts'
import { validateRenderReframePlan } from '../domain/render-reframe-plan.ts'
import { SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } from '../domain/subtitle-system.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { ArtifactSourceMaterializer, VerifiedMediaStorage } from './ports/media-ingest.ts'
import {
  EDITORIAL_PROXY_RECIPE_VERSION,
  FFMPEG_EDITORIAL_RENDERER_VERSION,
  type EditorialProxyRenderer,
} from './ports/editorial-proxy-renderer.ts'
import type { PerceptionTimelineRepository } from './ports/perception-timeline-repository.ts'
import type { ProjectProxyRenderRepository } from './ports/project-proxy-render-repository.ts'
import type { ProxyReviewRepository } from './ports/proxy-review-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { RenderElementMapRepository } from './ports/render-element-map-repository.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import type { ProjectLutRenderMaterializer } from './ports/project-lut-render-materializer.ts'
import type { OperationTelemetrySink } from './ports/operation-telemetry.ts'
import { runPublicOperationSpan } from './public-operation-span-telemetry.ts'
import { evaluateRenderedProxy } from './render-workflow.ts'
import { projectProxyRenderInputHash } from './project-render-sources.ts'
import { calculatePublicOperationRetryDelayMs, type PublicOperationWorkerOutcome } from './run-public-operation-worker.ts'
import { loadBoundRenderColorPipelines } from './resolve-render-color-pipelines.ts'

const NON_RETRYABLE_CODES = new Set(['INVALID_RENDER_INPUT', 'RENDER_OUTPUT_INVALID', 'PERSISTENCE_CONFLICT', 'PERSISTENCE_NOT_CONFIGURED'])

function safeFailure(error: unknown) {
  const retryable = !(error instanceof DomainError && NON_RETRYABLE_CODES.has(error.code))
  return { code: error instanceof DomainError ? error.code.toLowerCase() : 'render_execution_failed', message: 'Project proxy render could not be completed', retryable }
}

export function runNextProjectProxyRenderOperationService(dependencies: {
  operations: PublicOperationRepository
  projects: ProjectProxyRenderRepository
  artifacts: MediaArtifactPersistenceRepository
  storage: VerifiedMediaStorage
  renderer: EditorialProxyRenderer
  renderElementMaps: RenderElementMapRepository
  /**
   * F1.036 / FR-173. The worker reads the persisted perception timeline of the project so the
   * subtitle anchor is decided from real observations. It is a repository, not a payload: nothing
   * the render request carries can substitute for the evidence actually stored.
   */
  perceptionTimelines: PerceptionTimelineRepository
  proxyReviews: ProxyReviewRepository
  colorPipelines: ColorPipelineCompilationRepository
  luts: ProjectLutRenderMaterializer
  sources: ArtifactSourceMaterializer
  clock?: () => Date
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  telemetry?: OperationTelemetrySink
  catalogOutput: (target: { workspaceId: string; artifactId: string; manifestId: string }) => Promise<unknown>
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
  ) throw new DomainError('INVALID_PUBLIC_OPERATION', 'Project render worker lease configuration is invalid')
  const leaseWindow = (now: Date) => new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNext(leaseOwner: string): Promise<Readonly<PublicOperationWorkerOutcome> | null> {
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({ leaseOwner, now: claimedAt.toISOString(), leaseUntil: leaseWindow(claimedAt), type: 'project-proxy-render' })
    if (!claimed) return null
    if (claimed.context.kind !== 'project-proxy-render') throw new DomainError('PERSISTENCE_CONFLICT', 'Project render worker claimed an incompatible operation')
    const { operation, context } = claimed
    const attempt = claimed.lease.attempt
    const abortController = new AbortController()
    let stopped = false
    let leaseLost = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined
    let leaseCommandTail: Promise<void> = Promise.resolve()
    const command = (now: Date) => ({ operationId: operation.id, leaseOwner, attempt, now: now.toISOString() })
    const withLeaseCommand = <T>(action: () => Promise<T>): Promise<T> => {
      const result = leaseCommandTail.then(action)
      leaseCommandTail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    const heartbeat = async () => {
      if (stopped || leaseLost) return false
      if (renewal) return renewal
      renewal = withLeaseCommand(async () => {
        if (stopped || leaseLost) return !leaseLost
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
      })
      return renewal
    }
    const scheduleHeartbeat = () => {
      if (stopped || leaseLost) return
      timer = setTimeout(async () => { await heartbeat(); scheduleHeartbeat() }, heartbeatIntervalMs)
      timer.unref?.()
    }
    const stopHeartbeat = () => { stopped = true; if (timer) clearTimeout(timer) }
    const enter = async (phase: 'rendering' | 'verifying' | 'persisting') => {
      const entered = await withLeaseCommand(() =>
        dependencies.operations.advancePhase({ ...command(clock()), phase }))
      if (!entered) { leaseLost = true; abortController.abort(); throw new DomainError('RENDER_EXECUTION_FAILED', 'Project render lease was lost') }
    }
    try {
      scheduleHeartbeat()
      const source = await dependencies.projects.readImmutableSource({
        workspaceId: operation.workspaceId, projectId: context.projectId, projectVersionId: context.projectVersionId,
        editPlanSnapshotId: context.editPlanSnapshotId, sourceArtifactId: context.sourceArtifactId, sourceManifestId: context.sourceManifestId,
      })
      if (!source) throw new DomainError('PERSISTENCE_CONFLICT', 'Immutable project render source disappeared')
      const clips = source.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
      const colorPipelines = await loadBoundRenderColorPipelines({
        repository: dependencies.colorPipelines, workspaceId: operation.workspaceId,
        projectId: context.projectId, bindings: context.colorPipelineBindings,
      })
      if (source.renderSources.some((asset) => asset.mediaType === 'video' &&
        (!colorPipelines.has(asset.artifactId) || context.colorPipelineBindings.find((binding) => binding.sourceArtifactId === asset.artifactId)?.sourceManifestId !== asset.manifestId))) {
        throw new DomainError('INVALID_RENDER_INPUT', 'Render video source is missing its bound color pipeline')
      }
      const materializedLut = await dependencies.luts.materialize({
        workspaceId: operation.workspaceId, projectId: context.projectId, projectVersionId: context.projectVersionId,
        operationId: operation.id, compilations: [...colorPipelines.values()],
      })
      const immutableInputHash = projectProxyRenderInputHash({
        source,
        colorPipelineBindings: context.colorPipelineBindings,
      })
      if (
        immutableInputHash !== context.inputHash ||
        source.editPlan.movementPolicy.automaticZoom || clips.length < 1 ||
        source.editPlan.movementPolicy.protectedOpeningFrames < Math.round(source.editPlan.fps * 4)
      ) throw new DomainError('INVALID_RENDER_INPUT', 'Compiled EditPlan is not safe to render')
      const subtitleCues = source.editPlan.subtitleTracks.flatMap((track) => 'cues' in track ? track.cues : [])
      const ctaOverlays = (source.editPlan.overlayTracks ?? []).filter(
        (track) => 'kind' in track && track.kind === 'cta',
      )
      const transitions = 'transitions' in source.editPlan ? source.editPlan.transitions : []
      const composition = 'composition' in source.editPlan ? source.editPlan.composition : undefined
      const audioTimelineHash = createEditorialAudioTimelineHash({ fps: source.editPlan.fps, clips })
      if ('audioTimelineHash' in source.editPlan && source.editPlan.audioTimelineHash !== audioTimelineHash) throw new DomainError('INVALID_RENDER_INPUT', 'Persisted Director audio timeline identity changed before proxy render')
      // ---- Materialized geometry, decided and validated before the renderer is asked to run ----
      const outputPreset = readOutputFormatPreset(source.format as OutputAspectRatio)
      const durationFrames = source.editPlan.durationFrames
      const subtitleResolution = source.subtitleResolution
      if (subtitleResolution) {
        // A resolution persisted against another registry revision (or a tampered preset hash) can
        // never reach the renderer: the subtitle geometry it implies would not be the one drawn.
        if (
          subtitleResolution.registryHash !== SUBTITLE_STYLE_REGISTRY.registryHash ||
          (subtitleResolution.enabled && subtitleResolution.presetHash !== subtitlePresetHash(subtitleResolution.presetId))
        ) throw new DomainError('INVALID_RENDER_INPUT', 'Persisted subtitle resolution drifted from the subtitle style registry')
      }
      const placementElements: RenderPlacementRequestV1[] = ctaOverlays.map((overlay, index) => ({
        id: `cta-${index}-${overlay.id ?? index}`.slice(0, 96),
        kind: 'cta' as const, anchor: 'auto' as const, priority: 80, readingOrder: index,
        minWidth: 0.1, maxWidth: 0.9, minHeight: 0.05, maxHeight: 0.5,
        timeRange: { startFrame: overlay.startFrame, endFrame: overlay.endFrame },
      }))
      // Perception evidence for *this* version. A timeline recorded against another version is not
      // evidence about these frames, so it is ignored rather than approximated — the anchor then
      // falls back to the reserved bottom band, which is the Director's face-safe fallback.
      const persistedPerception = subtitleResolution?.enabled && subtitleCues.length
        ? await dependencies.perceptionTimelines.findLatest({ workspaceId: operation.workspaceId, projectId: context.projectId })
        : null
      const perceptionTimeline = persistedPerception && persistedPerception.projectVersionId === context.projectVersionId
        ? persistedPerception.timeline
        : undefined
      const placementPlan = createRenderPlacementPlan({
        format: source.format as OutputAspectRatio,
        canvas: { width: outputPreset.exportDefaults.proxy.width, height: outputPreset.exportDefaults.proxy.height },
        durationFrames,
        // The subtitle band is reserved from the *resolved* preset, so a CTA is never solved into
        // the rows the subtitles already own — and never from a rectangle authored here.
        subtitlePresetId: subtitleResolution?.enabled ? subtitleResolution.presetId : null,
        elements: placementElements,
        ...(subtitleResolution?.enabled && subtitleCues.length ? {
          subtitleAnchor: {
            fps: source.editPlan.fps,
            cues: subtitleCues.map((cue) => ({ id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame })),
            ...(perceptionTimeline ? { perceptionTimeline } : {}),
          },
        } : {}),
      })
      validateRenderPlacementPlan(placementPlan)
      const reframePlan = source.reframePlan
      if (reframePlan) {
        validateRenderReframePlan(reframePlan)
        if (
          reframePlan.variantId !== source.format ||
          reframePlan.format !== source.format ||
          reframePlan.durationFrames !== durationFrames ||
          Math.abs(reframePlan.fps - source.editPlan.fps) > 0.01
        ) throw new DomainError('INVALID_RENDER_INPUT', 'Persisted reframe plan does not describe this render')
      }
      await enter('rendering')
      const materializedSources = await Promise.all(source.renderSources.map((asset) =>
        dependencies.sources.materialize({
          operationId: operation.id,
          artifactKey: asset.artifactKey,
          sha256: asset.sha256,
          byteSize: asset.byteSize,
        })))
      const materializedRangeReuse = source.rangeReuse
        ? await dependencies.sources.materialize({
            operationId: operation.id,
            artifactKey: source.rangeReuse.artifactKey,
            sha256: source.rangeReuse.sha256,
            byteSize: source.rangeReuse.byteSize,
          })
        : undefined
      const render = () => dependencies.renderer.render({
        operationId: operation.id,
        renderKind: 'proxy',
        sources: source.renderSources.map((asset, index) => ({
          artifactId: asset.artifactId,
          path: materializedSources[index]!.path,
          mediaType: asset.mediaType,
          ...(asset.mediaType === 'video' ? { colorPipelineCompilation: colorPipelines.get(asset.artifactId)! } : {}),
        })),
        lutPaths: materializedLut.lutPaths,
        clips, audioTimelineHash, fps: source.editPlan.fps, format: source.format, subtitleCues,
        ...(ctaOverlays.length ? { ctaOverlays } : {}),
        transitions, ...(composition ? { composition } : {}),
        placementPlan,
        ...(reframePlan ? { reframePlan } : {}),
        ...(source.rangeReuse ? {
          rangeReuse: {
            ...source.rangeReuse,
            path: materializedRangeReuse!.path,
          },
        } : {}),
        signal: abortController.signal,
      })
      const rendered = dependencies.telemetry
        ? await runPublicOperationSpan({
            telemetry: dependencies.telemetry,
            record: claimed,
            spanKind: 'renderer',
            spanName: 'ffmpeg-editorial-proxy',
            clock,
            action: render,
            metrics: (result) => ({ outputBytes: result.byteSize }),
          })
        : await render()
      await enter('verifying')
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Project render lease was lost')
      await enter('persisting')
      const stored = await dependencies.storage.promoteDerived({ workspaceId: operation.workspaceId, sourcePath: rendered.outputPath, sha256: rendered.sha256, extension: 'mp4', prefix: 'editorial-proxies' })
      const toolDigest = createHash('sha256')
        .update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`)
        .digest('hex')
      const manifest = createMediaArtifactManifestV2({
        artifactKey: stored.key, artifactSha256: stored.sha256, byteSize: stored.byteSize, mediaType: 'video', container: 'mp4',
        recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION, parameters: { inputHash: context.inputHash, audioTimelineHash, projectVersionId: context.projectVersionId, editPlanSnapshotId: context.editPlanSnapshotId, format: source.format, colorPipelineBindings: context.colorPipelineBindings, rangeReuse: source.rangeReuse ? { schemaVersion: source.rangeReuse.schemaVersion, commandId: source.rangeReuse.commandId, impactHash: source.rangeReuse.impactHash, baseVersionId: source.rangeReuse.baseVersionId, ranges: source.rangeReuse.ranges, artifactId: source.rangeReuse.artifactId, manifestId: source.rangeReuse.manifestId, sha256: source.rangeReuse.sha256, byteSize: source.rangeReuse.byteSize } : null, projectLutSelectionId: materializedLut.selectionId, projectLutSelectionHash: materializedLut.selectionHash, materializedCubeHash: materializedLut.materializedCubeHash ?? null, placementPlanHash: placementPlan.placementPlanHash, reframePlanHash: reframePlan?.reframePlanHash ?? null, subtitleRegistryHash: subtitleResolution?.registryHash ?? null, subtitleAnchorPlanHash: placementPlan.subtitleAnchorPlan?.anchorPlanHash ?? null, perceptionTimelineHash: placementPlan.subtitleAnchorPlan?.perceptionTimelineHash ?? null } },
        sources: [
          ...source.renderSources.map((asset) => ({
            artifactKey: asset.artifactKey,
            sha256: asset.sha256,
            role: asset.role,
            execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } },
          })),
          ...(source.rangeReuse ? [{
            artifactKey: source.rangeReuse.artifactKey,
            sha256: source.rangeReuse.sha256,
            role: 'reused-proxy-range',
            execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } },
          }] : []),
        ],
        probe: { width: rendered.probe.width, height: rendered.probe.height, duration: rendered.probe.duration, fps: rendered.probe.fps },
      })
      const persisted = await dependencies.artifacts.persistOrReplay({
        workspaceId: operation.workspaceId, artifactId: context.outputArtifactId, manifestId: context.outputManifestId,
        lineageIds: [...source.renderSources, ...(source.rangeReuse ? [source.rangeReuse] : [])].map((asset, index) =>
          `lineage-${createHash('sha256')
            .update(`${operation.workspaceId}:${context.inputHash}:${asset.artifactId}:${index}`)
            .digest('hex')}`),
        manifest, createdAt: clock().toISOString(),
      })
      if (persisted.artifactId !== context.outputArtifactId || persisted.manifestId !== context.outputManifestId) throw new DomainError('PERSISTENCE_CONFLICT', 'Project render artifact identity did not converge')
      await dependencies.renderElementMaps.persistOrReplay({
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
        proxyArtifactId: persisted.artifactId,
        map: rendered.renderElementMap,
        createdAt: clock().toISOString(),
      })
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Project render lease was lost')
      await dependencies.projects.attachCompletedOutput({
        workspaceId: operation.workspaceId, operationId: operation.id, projectId: context.projectId,
        projectVersionId: context.projectVersionId, variantId: source.format,
        outputArtifactId: context.outputArtifactId, outputManifestId: context.outputManifestId,
        originalFileName: context.originalFileName, createdAt: clock().toISOString(),
      })
      const reviewedAt = clock().toISOString()
      const review = evaluateRenderedProxy({
        projectVersionId: context.projectVersionId,
        proxyArtifactId: persisted.artifactId,
        proxyManifestId: persisted.manifestId,
        proxySha256: stored.sha256,
        inputHash: context.inputHash,
        format: source.format,
        sourceSha256: source.sourceSha256,
        editPlanHash: source.editPlanHash,
        expectedDurationMs: Math.round(source.editPlan.durationFrames / source.editPlan.fps * 1_000),
        uploadReceivedAt: source.uploadReceivedAt,
        renderCompletedAt: reviewedAt,
        probe: rendered.probe,
        map: rendered.renderElementMap,
        ...('composition' in source.editPlan
          ? {
              faceSafeRegion: source.editPlan.composition.faceSafeFallback,
              subtitleSafeRegion: source.editPlan.composition.subtitleSafeRegion,
            }
          : {}),
        criticIssues: source.criticIssues,
        // The critic runs on the rendered proxy, after the geometry above was materialized, and
        // every issue it produces is bound to the exact plans that produced these frames.
        formatCritic: {
          outputSpecId: outputPreset.spec.id,
          placementPlanHash: placementPlan.placementPlanHash,
          reframePlanHash: reframePlan?.reframePlanHash ?? null,
          // Subject evidence persisted for this variant. Forwarded untouched: without it the
          // subject-dependent reason codes could never fire on a real render.
          ...(source.formatSubjects ? { subjects: source.formatSubjects } : {}),
          // The anchor decision reports into the variant verdict: a cue that had no safe band
          // blocks this output instead of shipping a subtitle over a face.
          subtitleAnchorPlan: placementPlan.subtitleAnchorPlan,
        },
      })
      await dependencies.proxyReviews.persistGenerated({
        id: `proxy-review-${createHash('sha256').update(operation.id).digest('hex').slice(0, 32)}`,
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        operationId: operation.id,
        review,
        createdAt: reviewedAt,
      })
      await dependencies.catalogOutput({ workspaceId: operation.workspaceId, artifactId: persisted.artifactId, manifestId: persisted.manifestId })
      stopHeartbeat()
      const succeeded = await withLeaseCommand(() =>
        dependencies.operations.succeed(command(clock())))
      if (!succeeded) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      return Object.freeze({ operationId: operation.id, status: 'succeeded' as const })
    } catch (error) {
      stopHeartbeat()
      if (leaseLost) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      const failedAt = clock()
      const failure = safeFailure(error)
      const nextAttemptAt = failure.retryable && attempt < operation.maxAttempts ? new Date(failedAt.getTime() + calculatePublicOperationRetryDelayMs({ attempt, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs })).toISOString() : undefined
      const failed = await withLeaseCommand(() =>
        dependencies.operations.failOrRetry({ ...command(failedAt), error: failure, ...(nextAttemptAt ? { nextAttemptAt } : {}) }))
      if (!failed) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      return Object.freeze({ operationId: operation.id, status: failed.operation.status === 'retrying' ? 'retrying' as const : 'failed' as const })
    } finally {
      stopHeartbeat()
      await Promise.allSettled([
        dependencies.renderer.cleanup(operation.id),
        dependencies.luts.cleanup(operation.id),
        dependencies.sources.cleanup(operation.id),
      ])
    }
  }
}
