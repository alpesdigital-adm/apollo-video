import { assertPlanHonorsResolution } from '../domain/editorial-policy-resolution.ts'
import { createHash } from 'node:crypto'

import { artifactOutputStoragePrefix } from '../domain/artifact-storage-identity.ts'
import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import { DomainError } from '../domain/errors.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import { createDirectedAudioTimelineHash } from '../domain/director-run.ts'
import { plannedCaptionsOverKeptFrames } from './plan-caption-placement.ts'
import type { FaceSourceWindowEvidenceReader } from './ports/face-source-window-evidence-reader.ts'
import type { CaptionPixelCritic } from './ports/caption-pixel-critic.ts'
import type { Mp4PixelCritic } from './ports/mp4-pixel-critic.ts'
import { persistMp4QualityReport, verifyDeliveredMp4, type DeliveredMp4Verification } from './verify-delivered-mp4.ts'
import { evaluateCaptionPixels, type CaptionPixelIssueV1 } from '../domain/caption-pixel-verdict.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { ArtifactSourceMaterializer, VerifiedMediaStorage } from './ports/media-ingest.ts'
import {
  EDITORIAL_PROXY_RECIPE_VERSION,
  FFMPEG_EDITORIAL_RENDERER_VERSION,
  type EditorialProxyRenderer,
} from './ports/editorial-proxy-renderer.ts'
import type { PerceptionTimelineRepository } from './ports/perception-timeline-repository.ts'
import type { ProjectProxyRenderRepository } from './ports/project-proxy-render-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { RenderElementMapRepository } from './ports/render-element-map-repository.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import type { ProjectLutRenderMaterializer } from './ports/project-lut-render-materializer.ts'
import type { ProjectColorPlanRepository } from './ports/project-color-plan-repository.ts'
import type { OperationTelemetrySink } from './ports/operation-telemetry.ts'
import { runPublicOperationSpan } from './public-operation-span-telemetry.ts'
import {
  colorCriticRenderInputs,
  ColorCriticVerdictNotRecordedError,
  type EvaluateColorCriticRequest,
  type EvaluateColorCriticResult,
} from './color-critic.ts'
import { evaluateRenderedProxy, type ProxyQualityIssue } from './render-workflow.ts'
import { contextVariantSelection, projectProxyRenderContentHash, projectProxyRenderInputHash, sourceOutputVariantId } from './project-render-sources.ts'
import { deriveProxyRenderGeometry, proxyDirectorCriticIssuesDigest } from './proxy-render-evidence.ts'
import { appliedColorGradeMatches } from '../domain/render-color-grade.ts'
import { ASS_EMISSION_POLICY } from '../domain/ass-emission-policy.ts'
import { calculatePublicOperationRetryDelayMs, type PublicOperationWorkerOutcome } from './run-public-operation-worker.ts'
import { loadBoundRenderColorPipelines } from './resolve-render-color-pipelines.ts'
import { calculateVersionHash } from './version-hash.ts'
import { immediateNextAttemptAt, workerShutdownFailure } from './worker-lifecycle.ts'

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
  /** Reserved for a future server-verified producer; caller PUT timelines cannot authorize face safety. */
  perceptionTimelines: PerceptionTimelineRepository
  colorPipelines: ColorPipelineCompilationRepository
  colorPlans: Pick<ProjectColorPlanRepository, 'readEffectiveForVersion'>
  luts: ProjectLutRenderMaterializer
  sources: ArtifactSourceMaterializer
  /**
   * W65. The sealed face windows of the Version being rendered. Optional: without it no source has evidence, so every band
   * over the picture is unknown and its cue is not drawn.
   */
  faceEvidence?: FaceSourceWindowEvidenceReader
  /**
   * W65. Measures, on the delivered MP4, where the captions the plan placed really are, against the same render without the burned
   * cues. Optional: a deployment without it ships the plan's decision unverified in pixels. When it is wired and a plan draws a
   * cue, its issues land on the review; if it cannot run, that is a warning, never a pass.
   */
  captionPixelCritic?: CaptionPixelCritic
  /**
   * W67. The independent critic of the delivered MP4: it decodes every frame, measures captions, CTA, safe area, subject and density on the
   * pixels against control encodes of the same input, and seals a report. Its hard issues block THIS output only; if it is wired and cannot
   * run, the review is a warning (never a pass). Optional: a deployment without it ships the plan's decisions unverified in pixels.
   */
  mp4PixelCritic?: Mp4PixelCritic
  clock?: () => Date
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  telemetry?: OperationTelemetrySink
  onFailureDiagnostic?: (diagnostic: Readonly<{ operationId: string; error: unknown }>) => void
  /**
   * F4.014. When a deployment has the colour critic wired, the rendered proxy
   * is judged before its review is written and the verdict lands as issues on
   * that review: `reject` blocks the final export, `human-review` and
   * `bounded-correction` hold it in `warning-ack-required` until a person
   * acknowledges them. Optional, because a deployment without an evaluator has
   * no colour verdict to report.
   *
   * It is one object rather than three fields because judging and cleaning up
   * are not separable: the evaluator re-encodes every video source and writes
   * two PNGs per camera, and a deployment that wired `evaluate` without
   * `cleanup` would leak all of it on every render. `locateSession` finds the
   * capture session whose match plan named the reference camera these frames
   * were corrected towards; it is given the cameras the render actually cut to,
   * because "the project's most recent session" is not the same question.
   */
  colorCritic?: Readonly<{
    evaluate: (request: EvaluateColorCriticRequest) => Promise<Readonly<EvaluateColorCriticResult>>
    /** Remove the intermediates and crops this operation wrote. Reports, never throws. */
    cleanup: (operationId: string) => Promise<void>
    locateSession?: (context: {
      workspaceId: string
      projectId: string
      cameraIds: readonly string[]
    }) => Promise<string | null>
  }>
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

  return async function runNext(
    leaseOwner: string,
    target: Readonly<{ workspaceId?: string; operationId?: string; signal?: AbortSignal }> = {},
  ): Promise<Readonly<PublicOperationWorkerOutcome> | null> {
    if (target.signal?.aborted) throw target.signal.reason ?? new Error('Project proxy rendering aborted')
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({ leaseOwner, now: claimedAt.toISOString(), leaseUntil: leaseWindow(claimedAt), type: 'project-proxy-render', ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), ...(target.operationId ? { operationId: target.operationId } : {}) })
    if (!claimed) return null
    if (claimed.context.kind !== 'project-proxy-render') throw new DomainError('PERSISTENCE_CONFLICT', 'Project render worker claimed an incompatible operation')
    const { operation, context } = claimed
    const attempt = claimed.lease.attempt
    const abortController = new AbortController()
    const abortFromTarget = () => abortController.abort(target.signal?.reason)
    target.signal?.addEventListener('abort', abortFromTarget, { once: true })
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
    let verifyCommittedCompletion: (() => Promise<void>) | undefined
    try {
      scheduleHeartbeat()
      const source = context.renderableSnapshot
        ? await dependencies.projects.readRenderableSnapshotSource({
            workspaceId: operation.workspaceId,
            projectId: context.projectId,
            planId: context.renderableSnapshot.planId,
            planHash: context.renderableSnapshot.planHash,
            format: context.renderableSnapshot.format,
            ...contextVariantSelection(context),
          })
        : await dependencies.projects.readImmutableSource({
            workspaceId: operation.workspaceId, projectId: context.projectId, projectVersionId: context.projectVersionId,
            editPlanSnapshotId: context.editPlanSnapshotId, sourceArtifactId: context.sourceArtifactId, sourceManifestId: context.sourceManifestId,
            purpose: 'render',
            ...contextVariantSelection(context),
            // Sealed to a Version that is no longer the head: it can never publish, so it refuses before it renders anything.
            requireCurrent: true,
          })
      if (!source) throw new DomainError('PERSISTENCE_CONFLICT', 'Immutable project render source disappeared')
      // The output this render was made for is the one the operation persisted; a source sealed to another output is no source.
      const outputVariantId = sourceOutputVariantId(source)
      if (context.outputVariantId !== undefined && context.outputVariantId !== outputVariantId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Immutable project render source is not the output its operation was made for')
      }
      const clips = source.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
      const colorPlan = await dependencies.colorPlans.readEffectiveForVersion({
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
      })
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
        ...(colorPlan ? { executions: colorPlan.compiled.targets } : {}),
      })
      // W70 readiness (R2). The grade applied here (the ColorPlan read above, the LUT selection just materialized) is the one the source was
      // read with, which the input hash and the content address name: otherwise the render would be identified by a grade it does not have.
      if (source.colorGrade && !appliedColorGradeMatches(source.colorGrade, {
        colorPlan, lut: { selectionId: materializedLut.selectionId, selectionHash: materializedLut.selectionHash },
      })) throw new DomainError('INVALID_RENDER_INPUT', 'The colour grade this render applies is not the one its source was read with')
      const baseInputHash = projectProxyRenderInputHash({ source, colorPipelineBindings: context.colorPipelineBindings })
      const immutableInputHash = context.renderableSnapshot
        ? calculateVersionHash({ type: 'renderable-snapshot-proxy/v1', snapshot: context.renderableSnapshot, renderInputHash: baseInputHash })
        : baseInputHash
      if (
        immutableInputHash !== context.inputHash || clips.length < 1
      ) throw new DomainError('INVALID_RENDER_INPUT', 'Compiled EditPlan is not safe to render')
      // ADR-160. The plan is judged against the resolution it was made from (its movement and opening window), not against values of the worker.
      assertPlanHonorsResolution(source.editPlan, source.policyResolution)
      // W70 readiness (R2). The content address written at enqueue is what a later Version carries this render by: it must be the address
      // of what is rendered now, or the carry would vouch for inputs nobody rendered. Recomputed here from the sealed source; a row written
      // before the address existed has none (and is never a carry source).
      if (!context.renderableSnapshot && context.renderContentHash !== undefined &&
          projectProxyRenderContentHash({ source, colorPipelineBindings: context.colorPipelineBindings }) !== context.renderContentHash) {
        throw new DomainError('INVALID_RENDER_INPUT', 'The content address of this proxy moved between enqueue and render')
      }
      const transitions = 'transitions' in source.editPlan ? source.editPlan.transitions : []
      const composition = 'composition' in source.editPlan ? source.editPlan.composition : undefined
      const musicTracks = 'audioTracks' in source.editPlan && Array.isArray(source.editPlan.audioTracks) ? source.editPlan.audioTracks : []
      const audioTimelineHash = musicTracks.length > 0
        ? createDirectedAudioTimelineHash({ fps: source.editPlan.fps, clips, musicTracks })
        : createEditorialAudioTimelineHash({ fps: source.editPlan.fps, clips })
      if ('audioTimelineHash' in source.editPlan && source.editPlan.audioTimelineHash !== audioTimelineHash) throw new DomainError('INVALID_RENDER_INPUT', 'Persisted Director audio timeline identity changed before proxy render')
      // ---- Materialized geometry, decided and validated before the renderer is asked to run ----
      // The same derivation the final export worker runs (one authority: cues, CTA overlays, the
      // placement plan with its unknown-face anchor plan, and the persisted reframe plan); only the
      // canvas differs, because a placement plan is addressed against the pixels it is drawn on.
      // W70 readiness (R2): `deriveProxyRenderGeometry` is also what a carry runs, so the digest of the face windows read here is the one a
      // later Version is compared with. The W65b rule applies (an uncertifiable cue is omitted and listed).
      // W70 readiness (R3): `captionOverflows` are the drawn cues whose text does not fit the band the plan certified, decided here, before the
      // render, by the layout the renderer draws with. The proxy draws them as they are and its review is BLOCKED by them (a hard issue).
      const {
        subtitleCues, subtitleResolution, ctaOverlays, placementPlan, reframePlan, reframeIssues, subtitleOverrideReceipt, outputPreset, faceEvidenceDigest,
        captionOverflows,
      } = await deriveProxyRenderGeometry({
        source, workspaceId: operation.workspaceId, projectId: context.projectId,
        ...(dependencies.faceEvidence ? { faceEvidence: dependencies.faceEvidence } : {}),
        clock,
      })
      // The kept ranges of a reuse are base bytes without any caption; a plan that draws one over them needs the full render.
      const rangeReuse = source.rangeReuse && !reframePlan && !plannedCaptionsOverKeptFrames(placementPlan, source.rangeReuse.ranges) ? source.rangeReuse : undefined
      const ocrReceipt = source.trustedOcr ? Object.freeze({
        envelopeId: source.trustedOcr.envelopeId,
        envelopeHash: source.trustedOcr.envelopeHash,
        inputVersionId: source.trustedOcr.inputVersionId,
        timeMapHash: source.trustedOcr.timeMapHash,
        timelineHash: source.trustedOcr.timeline.timelineHash,
        sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId,
        sourceSha256: source.sourceSha256,
        editPlanHash: source.editPlanHash,
      }) : null
      if (context.renderableSnapshot && ocrReceipt) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot cannot inherit Director OCR coordinates')
      }
      await enter('rendering')
      const materializedSources = await Promise.all(source.renderSources.map((asset) =>
        dependencies.sources.materialize({
          operationId: operation.id,
          artifactKey: asset.artifactKey,
          sha256: asset.sha256,
          byteSize: asset.byteSize,
        })))
      const materializedRangeReuse = rangeReuse
        ? await dependencies.sources.materialize({
            operationId: operation.id,
            artifactKey: rangeReuse.artifactKey,
            sha256: rangeReuse.sha256,
            byteSize: rangeReuse.byteSize,
          })
        : undefined
      const renderRequest: Parameters<typeof dependencies.renderer.render>[0] = {
        operationId: operation.id,
        renderKind: 'proxy',
        sources: source.renderSources.map((asset, index) => ({
          artifactId: asset.artifactId,
          path: materializedSources[index]!.path,
          mediaType: asset.mediaType,
          ...(asset.mediaType === 'video' ? { colorPipelineCompilation: colorPipelines.get(asset.artifactId)! } : {}),
        })),
        lutPaths: materializedLut.lutPaths,
        ...(colorPlan ? { colorPlan } : {}),
        clips, audioTimelineHash, fps: source.editPlan.fps, format: source.format, subtitleCues,
        ...('audioTracks' in source.editPlan && source.editPlan.audioTracks[0] ? { backgroundMusic: source.editPlan.audioTracks[0] } : {}),
        ...(ctaOverlays.length ? { ctaOverlays } : {}),
        transitions, ...(composition ? { composition } : {}),
        placementPlan,
        ...(reframePlan ? { reframePlan } : {}),
        ...(rangeReuse ? {
          rangeReuse: {
            ...rangeReuse,
            path: materializedRangeReuse!.path,
          },
        } : {}),
        signal: abortController.signal,
      }
      const render = () => dependencies.renderer.render(renderRequest)
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
      // ---- F4.014. The colour verdict, taken on the bytes that were rendered ----
      // Before promotion, because the critic reads the file the renderer wrote
      // and the artifact id it will be promoted under is already known. The
      // verdict becomes issues on the review below; it is never applied to the
      // frames, so a rejected render is a blocked render, not a silently
      // corrected one.
      const colorCriticIssues: ProxyQualityIssue[] = []
      if (dependencies.colorCritic) {
        const criticInputs = colorCriticRenderInputs({
          clips,
          sources: source.renderSources.map((asset, index) => ({
            artifactId: asset.artifactId,
            path: materializedSources[index]!.path,
            sha256: asset.sha256,
            mediaType: asset.mediaType,
          })),
          ...(colorPlan ? { compiledTargets: colorPlan.compiled.targets } : {}),
          compilationPipelines: new Map(
            [...colorPipelines.entries()].map(([artifactId, compilation]) => [artifactId, compilation.pipeline]),
          ),
        })
        if (criticInputs.clips.length > 0) {
          try {
            const cameraIds = [...new Set(criticInputs.clips.map((clip) => clip.cameraId))].sort()
            const sessionId = dependencies.colorCritic.locateSession
              ? await dependencies.colorCritic.locateSession({
                  workspaceId: operation.workspaceId,
                  projectId: context.projectId,
                  cameraIds,
                })
              : null
            const verdict = await dependencies.colorCritic.evaluate({
              workspaceId: operation.workspaceId,
              projectId: context.projectId,
              projectVersionId: context.projectVersionId,
              deliveredArtifactId: context.outputArtifactId,
              deliveredPath: rendered.outputPath,
              deliveredSha256: rendered.sha256,
              operationId: operation.id,
              fps: source.editPlan.fps,
              clips: criticInputs.clips,
              sources: criticInputs.sources,
              lutPaths: materializedLut.lutPaths,
              ...(sessionId ? { sessionId } : {}),
              signal: abortController.signal,
            })
            colorCriticIssues.push(...verdict.proxyIssues)
          } catch (error) {
            if (error instanceof ColorCriticVerdictNotRecordedError) {
              // The frames WERE judged; only the row is missing. Reporting the
              // verdict as a warning here is how a rejection a database hiccup
              // swallowed becomes something a person can click through.
              colorCriticIssues.push(...error.proxyIssues, Object.freeze({
                code: 'COLOR_CRITIC_REPORT_UNRECORDED',
                severity: 'warning' as const,
                category: 'technical' as const,
                message: `The colour verdict ${error.report.action} (${error.report.cause}) on report ${error.report.reportId} was reached but could not be recorded; it is reported here from the run that computed it.`,
                correctable: false,
              }))
            } else {
              // ADR-147: evidence nobody could read is a decision, not an
              // approval. A critic that was wired and could not run leaves the
              // proxy waiting for a person rather than passing it through — and
              // it does not fail the render, because a rendered file that nobody
              // judged is still a rendered file.
              colorCriticIssues.push(Object.freeze({
                code: 'COLOR_CRITIC_UNAVAILABLE',
                severity: 'warning',
                category: 'technical',
                message: `The colour critic could not evaluate this render (${error instanceof DomainError ? error.code : 'unknown'}); its colour was not judged.`,
                correctable: false,
              }))
            }
          }
        }
      }
      // ---- W65. Where the captions really are, measured on the bytes that were rendered ----
      // Only a plan that draws a cue is worth the control render (the same input without the burned cues). The verdict becomes
      // issues on the review; it never edits the frames.
      const captionPixelIssues: CaptionPixelIssueV1[] = []
      const drawsCaptions = placementPlan.subtitleAnchorPlan?.decisions.some((decision) => decision.anchor !== null) === true
      if (dependencies.captionPixelCritic && drawsCaptions) {
        const controlOperationId = `${operation.id}-caption-control`
        try {
          const verification = await dependencies.captionPixelCritic.verify({
            plan: placementPlan, deliveredPath: rendered.outputPath, signal: abortController.signal,
            renderControl: async () => {
              const control = await dependencies.renderer.render({ ...renderRequest, operationId: controlOperationId, subtitleCues: [] })
              return { path: control.outputPath }
            },
          })
          captionPixelIssues.push(...verification.issues)
        } catch (error) {
          // A critic that was wired and broke leaves the proxy waiting for a person; it does not fail a render that was made.
          if (abortController.signal.aborted) throw error
          captionPixelIssues.push(...evaluateCaptionPixels({ plan: placementPlan, samples: [], faceVeto: 'unavailable', measurementFailed: true }))
        } finally {
          await dependencies.renderer.cleanup(controlOperationId).catch(() => undefined)
        }
      }
      // ---- W67. What the pixels of the delivered file say, read by the independent critic and sealed ----
      let mp4Verification: DeliveredMp4Verification | undefined
      if (dependencies.mp4PixelCritic) {
        mp4Verification = await verifyDeliveredMp4({
          critic: dependencies.mp4PixelCritic, renderer: dependencies.renderer, renderRequest, deliveredPath: rendered.outputPath,
          identity: {
            workspaceId: operation.workspaceId, projectId: context.projectId, projectVersionId: context.projectVersionId, variantId: outputVariantId,
            outputSpecId: outputPreset.spec.id, format: source.format, operationId: operation.id, renderInputHash: context.inputHash,
          },
          outputSpec: { width: outputPreset.exportDefaults.proxy.width, height: outputPreset.exportDefaults.proxy.height, safeArea: outputPreset.spec.safeArea },
          renderSources: source.renderSources, sourcePaths: materializedSources.map((materialized) => materialized.path), clips,
          overlays: { captions: drawsCaptions, cta: ctaOverlays.length > 0 }, controlOperationPrefix: operation.id, signal: abortController.signal,
        })
        if (mp4Verification.measurement === 'completed') {
          await persistMp4QualityReport({ storage: dependencies.storage, workspaceId: operation.workspaceId, report: mp4Verification.verification.report })
        }
      }
      await enter('persisting')
      const stored = await dependencies.storage.promoteDerived({ workspaceId: operation.workspaceId, sourcePath: rendered.outputPath, sha256: rendered.sha256, extension: 'mp4', prefix: artifactOutputStoragePrefix('editorial-proxy', context.outputArtifactId) })
      const toolDigest = createHash('sha256')
        .update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`)
        .digest('hex')
      const recipeParameters = Object.freeze({
        assEmissionPolicy: ASS_EMISSION_POLICY,
        inputHash: context.inputHash, audioTimelineHash,
        projectVersionId: context.projectVersionId,
        editPlanSnapshotId: context.editPlanSnapshotId,
        format: source.format,
        colorPipelineBindings: context.colorPipelineBindings,
        colorPlanHash: colorPlan?.plan.planHash ?? null,
        compiledColorPlanManifestHash: colorPlan?.compiled.manifestHash ?? null,
        rangeReuse: rangeReuse ? {
          schemaVersion: rangeReuse.schemaVersion,
          commandId: rangeReuse.commandId,
          impactHash: rangeReuse.impactHash,
          baseVersionId: rangeReuse.baseVersionId,
          ranges: rangeReuse.ranges,
          artifactId: rangeReuse.artifactId,
          manifestId: rangeReuse.manifestId,
          sha256: rangeReuse.sha256,
          byteSize: rangeReuse.byteSize,
        } : null,
        projectLutSelectionId: materializedLut.selectionId,
        projectLutSelectionHash: materializedLut.selectionHash,
        materializedCubeHash: materializedLut.materializedCubeHash ?? null,
        materializedCubeHashes: materializedLut.materializedCubeHashes ?? [],
        placementPlanHash: placementPlan.placementPlanHash,
        reframePlanHash: reframePlan?.reframePlanHash ?? null,
        subtitleRegistryHash: subtitleResolution?.registryHash ?? null,
        subtitlePresetId: subtitleResolution?.enabled ? subtitleResolution.presetId : null,
        subtitlePresetVersion: subtitleResolution?.enabled ? 1 : null,
        subtitlePresetHash: subtitleResolution?.enabled ? subtitleResolution.presetHash : null,
        subtitlePresetSnapshotHash: subtitleResolution?.enabled ? subtitleResolution.presetSnapshot!.snapshotHash : null,
        subtitleAnchorPlanHash: placementPlan.subtitleAnchorPlan?.anchorPlanHash ?? null,
        perceptionTimelineHash: placementPlan.subtitleAnchorPlan?.perceptionTimelineHash ?? null,
        ocrReceipt,
        // W68. The per-segment exceptions this proxy was drawn with (absent when the output has none that carry a value, which keeps the
        // recipe of every earlier render byte for byte).
        ...(subtitleOverrideReceipt ? { subtitleOverrides: subtitleOverrideReceipt } : {}),
      })
      const manifest = createMediaArtifactManifestV2({
        artifactKey: stored.key, artifactSha256: stored.sha256, byteSize: stored.byteSize, mediaType: 'video', container: 'mp4',
        recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
          parameters: recipeParameters },
        sources: [
          ...source.renderSources.map((asset) => ({
            artifactKey: asset.artifactKey,
            sha256: asset.sha256,
            role: asset.role,
            execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } },
          })),
          ...(rangeReuse ? [{
            artifactKey: rangeReuse.artifactKey,
            sha256: rangeReuse.sha256,
            role: 'reused-proxy-range',
            execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } },
          }] : []),
          ...(materializedLut.assets ?? []).map((asset) => ({
            artifactKey: asset.artifactKey,
            sha256: asset.sha256,
            role: `creative-lut:${asset.parametersHash}`,
            execution: { tool: { id: 'apollo-lut-materializer', version: '1', digest: asset.cubeHash } },
          })),
        ],
        probe: { width: rendered.probe.width, height: rendered.probe.height, duration: rendered.probe.duration, fps: rendered.probe.fps },
      })
      const persisted = await dependencies.artifacts.persistOrReplay({
        workspaceId: operation.workspaceId, artifactId: context.outputArtifactId, manifestId: context.outputManifestId,
        lineageIds: [...source.renderSources, ...(rangeReuse ? [rangeReuse] : [])].map((asset, index) =>
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
              // Existing geometry field describes reserved layout, not verified face clearance.
              faceSafeRegion: source.editPlan.composition.faceSafeFallback,
              subtitleSafeRegion: source.editPlan.composition.subtitleSafeRegion,
            }
          : {}),
        criticIssues: [...(source.criticIssues ?? []), ...colorCriticIssues, ...(mp4Verification?.measurement === 'failed' ? [Object.freeze({
          code: 'MP4_PIXEL_CRITIC_UNAVAILABLE', severity: 'warning' as const, category: 'technical' as const,
          message: `The MP4 pixel critic could not read the delivered file (${mp4Verification.failureCode}); its pixels were not independently verified.`, correctable: false,
        })] : [])],
        // The critic runs on the rendered proxy, after the geometry above was materialized, and
        // every issue it produces is bound to the exact plans that produced these frames.
        formatCritic: {
          outputSpecId: outputPreset.spec.id,
          placementPlanHash: placementPlan.placementPlanHash,
          reframePlanHash: reframePlan?.reframePlanHash ?? null,
          // The set of subtitle exceptions these frames were drawn with: the final export refuses an approval that was given for another set.
          ...(source.subtitleOverridesHash ? { subtitleOverridesHash: source.subtitleOverridesHash } : {}),
          // The localized issues of the persisted plan: a subject the trajectory could not keep, evidence that was missing or uncertain.
          ...(reframeIssues.length ? { reframeIssues, reframeRecordHash: source.reframeRecordHash ?? null } : {}),
          // Subject evidence persisted for this variant. Forwarded untouched: without it the
          // subject-dependent reason codes could never fire on a real render.
          ...(source.formatSubjects ? { subjects: source.formatSubjects } : {}),
          // The anchor decision reports into the variant verdict: a cue that had no safe band
          // blocks this output instead of shipping a subtitle over a face.
          subtitleAnchorPlan: placementPlan.subtitleAnchorPlan,
          ...(captionPixelIssues.length ? { captionPixelIssues } : {}),
          // A text that does not fit its band blocks this output whatever the pixel critic's tolerance let through.
          ...(captionOverflows.length ? { captionLayoutOverflows: captionOverflows } : {}),
          ...(mp4Verification?.measurement === 'completed' ? { mp4PixelIssues: mp4Verification.verification.issues, mp4Evidence: mp4Verification.evidence } : {}),
        },
      })
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Project render lease was lost')
      const completion = {
        lease: { owner: leaseOwner, attempt, now: clock().toISOString() },
        review,
        workspaceId: operation.workspaceId, operationId: operation.id, projectId: context.projectId,
        outputArtifactId: context.outputArtifactId, outputManifestId: context.outputManifestId,
        originalFileName: context.originalFileName, createdAt: reviewedAt, recipeParameters,
      }
      verifyCommittedCompletion = () => (context.renderableSnapshot
        ? dependencies.projects.attachCompletedSnapshotOutput({
            ...completion, variantId: context.renderableSnapshot.variantId, ocrReceipt: null,
          })
        : dependencies.projects.attachCompletedOutput({
            // `variantId` is the stable State variant the render was made for; `format` is the aspect ratio the recipe records.
            ...completion, projectVersionId: context.projectVersionId,
            variantId: outputVariantId, format: source.format, ocrReceipt,
            // W70 readiness (R2). What the content address cannot see, as it was when these frames were decided: the face windows the
            // placement read (and the ones it still needs) and the Director's issues this review is built over. A carry compares both.
            renderEvidence: { faceEvidenceDigest, criticIssuesDigest: proxyDirectorCriticIssuesDigest(source.criticIssues) },
          }))
      await verifyCommittedCompletion()
      stopHeartbeat()
      return Object.freeze({ operationId: operation.id, status: 'succeeded' as const })
    } catch (error) {
      stopHeartbeat()
      // A connection can fail after the database committed. The repository's
      // succeeded replay verifies the complete sealed identity without writes.
      if (verifyCommittedCompletion) {
        try {
          const committed = await dependencies.operations.findById(operation.workspaceId, operation.id)
          if (committed?.operation.status === 'succeeded') {
            await verifyCommittedCompletion()
            return Object.freeze({ operationId: operation.id, status: 'succeeded' as const })
          }
        } catch { /* Preserve the original failure for the normal lease path. */ }
      }
      dependencies.onFailureDiagnostic?.(Object.freeze({ operationId: operation.id, error }))
      if (leaseLost) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      const failedAt = clock()
      const shuttingDown = target.signal?.aborted === true
      const failure = shuttingDown ? workerShutdownFailure() : safeFailure(error)
      const nextAttemptAt = failure.retryable && attempt < operation.maxAttempts
        ? shuttingDown
          ? immediateNextAttemptAt(failedAt)
          : new Date(failedAt.getTime() + calculatePublicOperationRetryDelayMs({ attempt, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs })).toISOString()
        : undefined
      const failed = await withLeaseCommand(() =>
        dependencies.operations.failOrRetry({ ...command(failedAt), error: failure, ...(nextAttemptAt ? { nextAttemptAt } : {}) }))
      if (!failed) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      return Object.freeze({ operationId: operation.id, status: failed.operation.status === 'retrying' ? 'retrying' as const : 'failed' as const })
    } finally {
      stopHeartbeat()
      target.signal?.removeEventListener('abort', abortFromTarget)
      // Every port that wrote media for this operation gets released here, the
      // colour critic included: its "before" intermediate is a full re-encode of
      // every video source and it writes two PNGs per camera. `allSettled`
      // because a cleanup that fails is reported by its own adapter and must not
      // hide the render's own outcome.
      await Promise.allSettled([
        dependencies.renderer.cleanup(operation.id),
        dependencies.luts.cleanup(operation.id),
        dependencies.sources.cleanup(operation.id),
        ...(dependencies.colorCritic ? [dependencies.colorCritic.cleanup(operation.id)] : []),
      ])
    }
  }
}
