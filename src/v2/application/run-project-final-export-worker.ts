import { createHash } from 'node:crypto'

import { artifactOutputStoragePrefix } from '../domain/artifact-storage-identity.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { createReconstructableMediaArtifactManifest } from '../domain/media-artifact.ts'
import { DomainError } from '../domain/errors.ts'
import { readOutputFormatPreset } from '../domain/output-format-registry.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import { createRenderInputSpec } from '../domain/render-input.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import { createDirectedAudioTimelineHash } from '../domain/director-run.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { ArtifactSourceMaterializer, VerifiedMediaStorage } from './ports/media-ingest.ts'
import {
  EDITORIAL_FINAL_RECIPE_VERSION,
  FFMPEG_EDITORIAL_RENDERER_VERSION,
  type EditorialProxyRenderer,
} from './ports/editorial-proxy-renderer.ts'
import type { ProjectFinalExportFailureStage, ProjectFinalExportRepository } from './ports/project-final-export-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { RenderElementMapRepository } from './ports/render-element-map-repository.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import type { ProjectLutRenderMaterializer } from './ports/project-lut-render-materializer.ts'
import type { ProjectColorPlanRepository } from './ports/project-color-plan-repository.ts'
import type { OperationTelemetrySink } from './ports/operation-telemetry.ts'
import { runPublicOperationSpan } from './public-operation-span-telemetry.ts'
import { contextVariantSelection, projectFinalRenderInputHash, projectRenderSourcesFingerprint, sourceOutputVariantId } from './project-render-sources.ts'
import { ASS_EMISSION_POLICY } from '../domain/ass-emission-policy.ts'
import { deriveEditorialRenderGeometry } from './derive-editorial-render-geometry.ts'
import {
  certifyFinalCaptions, describeFinalCaptionCertification, FINAL_CAPTION_CERTIFICATION_POLICY_SHA256, type FinalPixelCheck,
} from '../domain/final-caption-certification.ts'
import type { CaptionPixelCritic } from './ports/caption-pixel-critic.ts'
import type { Mp4PixelCritic } from './ports/mp4-pixel-critic.ts'
import { critiqueOutputFormat, selectExportableVariants } from '../domain/format-quality-critic.ts'
import { mp4ExportAcknowledgementRecord, mp4ExportGate, parseMp4ExportAcknowledgement, type Mp4ExportAcknowledgement } from '../domain/mp4-export-gate.ts'
import { persistMp4ExportAcknowledgement, persistMp4QualityReport, verifyDeliveredMp4 } from './verify-delivered-mp4.ts'
import type { FaceSourceWindowEvidenceReader } from './ports/face-source-window-evidence-reader.ts'
import { calculatePublicOperationRetryDelayMs, type PublicOperationWorkerOutcome } from './run-public-operation-worker.ts'
import { loadBoundRenderColorPipelines } from './resolve-render-color-pipelines.ts'
import {
  immediateNextAttemptAt,
  linkAbortSignal,
  workerShutdownFailure,
} from './worker-lifecycle.ts'

const NON_RETRYABLE_CODES = new Set([
  'INVALID_RENDER_INPUT',
  'RENDER_OUTPUT_INVALID',
  'PERSISTENCE_CONFLICT',
  'PERSISTENCE_NOT_CONFIGURED',
  'EDITORIAL_ACCEPTANCE_FAILED',
  'ASSET_RIGHTS_BLOCKED',
])

function safeFailure(error: unknown, stage: ProjectFinalExportFailureStage) {
  const retryable = !(error instanceof DomainError && NON_RETRYABLE_CODES.has(error.code))
  const nodeCode = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  return {
    code: error instanceof DomainError ? error.code.toLowerCase()
      : nodeCode === 'ENOENT' ? 'required_file_missing' : 'final_export_failed',
    message: 'Project final export could not be completed',
    retryable,
    stage,
  }
}

export function runNextProjectFinalExportOperationService(dependencies: {
  operations: PublicOperationRepository
  projects: ProjectFinalExportRepository
  rights: AssetRightsRepository
  artifacts: MediaArtifactPersistenceRepository
  storage: VerifiedMediaStorage
  renderer: EditorialProxyRenderer
  renderElementMaps: RenderElementMapRepository
  colorPipelines: ColorPipelineCompilationRepository
  colorPlans: Pick<ProjectColorPlanRepository, 'readEffectiveForVersion'>
  luts: ProjectLutRenderMaterializer
  sources: ArtifactSourceMaterializer
  /** W65/W65b. The sealed face windows of the SOURCES the approved Version plays; without them no cue over the picture can be certified. */
  faceEvidence?: FaceSourceWindowEvidenceReader
  /**
   * W65b. Confirms, on the delivered MP4, that every burned caption is where the plan put it. A final that burns at least one
   * caption is refused (before the encode) without it: a caption is never delivered on the strength of the plan alone.
   */
  captionPixelCritic?: CaptionPixelCritic
  /**
   * W67. The independent critic of the delivered MP4. The final FAILS CLOSED on it: the variant's sealed report is stored and its format report
   * goes through `selectExportableVariants`, and a blocked variant, a critic that could not read the file, a face oracle that failed, a final
   * with caption/CTA ink over frames the oracle could not read, or NO critic wired at all is never promoted, exported or cataloged
   * (see `mp4ExportGate`). Another variant's report neither blocks nor authorizes it. The canonical StoryPlan is not touched.
   */
  mp4PixelCritic?: Mp4PixelCritic
  /**
   * W67. The only way to deliver a final the critic could not fully judge for a reason about the deployment or the footage (no critic wired;
   * no face anywhere in a frame that carries ink): an explicit, recorded acknowledgement of who accepted it, when and why. It is copied into
   * the attempt's validator message. It never lifts a crashed oracle, an unreadable frame, a missing model or a blocked report.
   */
  mp4ExportAcknowledgement?: Mp4ExportAcknowledgement
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
  ) throw new DomainError('INVALID_PUBLIC_OPERATION', 'Final export worker lease configuration is invalid')
  const leaseWindow = (now: Date) => new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNext(
    leaseOwner: string,
    signal?: AbortSignal,
  ): Promise<Readonly<PublicOperationWorkerOutcome> | null> {
    if (signal?.aborted) return null
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
    const attemptStartedAt = claimedAt.toISOString()
    const abortController = new AbortController()
    // Until Wave 23 this controller only ever fired on lease loss, so a SIGTERM
    // during a final export (the longest encode Apollo runs) was not observed by
    // the renderer at all.
    const ownerLink = linkAbortSignal(signal, abortController)
    let stopped = false
    let leaseLost = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined
    let leaseCommandTail: Promise<void> = Promise.resolve()
    let attemptRecorded = false
    let failureStage: ProjectFinalExportFailureStage = 'source-read'
    let validators: Array<{ code: string; passed: boolean; message: string }> = []
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
      if (!entered) { leaseLost = true; abortController.abort(); throw new DomainError('RENDER_EXECUTION_FAILED', 'Final export lease was lost') }
    }
    const assertRights = async (
      artifactIds: readonly string[],
      locale: string,
    ) => {
      for (const artifactId of artifactIds) {
        const rights = await dependencies.rights.findCurrent(
          operation.workspaceId,
          artifactId,
        )
        for (const requiredUse of ['rendering', 'editorial-reuse'] as const) {
          const decision = evaluateAssetUse(rights?.snapshot ?? null, {
            workspaceId: operation.workspaceId,
            use: requiredUse,
            locale,
          }, clock())
          if (decision.outcome !== 'allow') {
            throw new DomainError(
              'ASSET_RIGHTS_BLOCKED',
              'A render source no longer permits final export and catalog promotion',
              { artifactId, requiredUse, reasonCodes: decision.reasonCodes },
            )
          }
        }
      }
    }
    try {
      scheduleHeartbeat()
      // `final` purpose: the repository reads the exact Version through the persisted `final` verdict (state/entry/spec sealed).
      const source = await dependencies.projects.readImmutableApprovedSource({
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
        projectVersionHash: context.projectVersionHash,
        editPlanSnapshotId: context.editPlanSnapshotId,
        directorRunId: context.directorRunId,
        qualitySnapshotId: context.qualitySnapshotId,
        qualitySnapshotHash: context.qualitySnapshotHash,
        proxyReviewId: context.proxyReviewId,
        proxyReviewHash: context.proxyReviewHash,
        proxyArtifactId: context.proxyArtifactId,
        sourceArtifactId: context.sourceArtifactId,
        sourceManifestId: context.sourceManifestId,
        ...contextVariantSelection(context),
        // Sealed to a Version that is no longer the head: it can never publish, so it refuses before it renders anything.
        requireCurrent: true,
      })
      if (!source) throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', 'Immutable approved final export source disappeared')
      // The output this export was approved for is the one the operation persisted; a source sealed to another output is no source.
      if (context.outputVariantId !== undefined && context.outputVariantId !== sourceOutputVariantId(source)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Immutable final export source is not the output its operation was approved for')
      }
      const clips = source.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
      failureStage = 'color-plan'
      const colorPlan = await dependencies.colorPlans.readEffectiveForVersion({
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
      })
      failureStage = 'color-bindings'
      const colorPipelines = await loadBoundRenderColorPipelines({
        repository: dependencies.colorPipelines, workspaceId: operation.workspaceId,
        projectId: context.projectId, bindings: context.colorPipelineBindings,
      })
      if (source.renderSources.some((asset) => asset.mediaType === 'video' &&
        (!colorPipelines.has(asset.artifactId) || context.colorPipelineBindings.find((binding) => binding.sourceArtifactId === asset.artifactId)?.sourceManifestId !== asset.manifestId))) {
        throw new DomainError('INVALID_RENDER_INPUT', 'Final render video source is missing its bound color pipeline')
      }
      failureStage = 'lut-materialization'
      const materializedLut = await dependencies.luts.materialize({
        workspaceId: operation.workspaceId, projectId: context.projectId, projectVersionId: context.projectVersionId,
        operationId: operation.id, compilations: [...colorPipelines.values()],
        ...(colorPlan ? { executions: colorPlan.compiled.targets } : {}),
      })
      failureStage = 'input-validation'
      const immutableInputHash = projectFinalRenderInputHash({
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
        projectVersionHash: context.projectVersionHash,
        editPlanSnapshotId: source.editPlanSnapshotId,
        editPlanHash: source.editPlanHash,
        directorRunId: source.directorRunId,
        qualitySnapshotId: source.qualitySnapshotId,
        qualitySnapshotHash: source.qualitySnapshotHash,
        proxyReviewId: source.proxyReviewId,
        proxyReviewHash: source.proxyReviewHash,
        proxyArtifactId: source.proxyArtifactId,
        sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId,
        sourceSha256: source.sourceSha256,
        renderSourcesFingerprint: projectRenderSourcesFingerprint(source.renderSources),
        colorPipelineBindings: context.colorPipelineBindings,
        outputSpec: context.outputSpec,
        // Re-read through the same `final` verdict: another State, variant revision or materialization is another input hash.
        outputConsumptionSealHash: source.outputConsumption.sealHash,
        ...(source.reframeRecordHash ? { reframeRecordHash: source.reframeRecordHash } : {}),
      })
      if (
        immutableInputHash !== context.inputHash ||
        source.editPlan.movementPolicy.automaticZoom || clips.length < 1 ||
        source.editPlan.movementPolicy.protectedOpeningFrames < Math.round(source.editPlan.fps * 4) ||
        source.format !== context.outputSpec.aspectRatio ||
        source.proxyReviewId !== context.proxyReviewId ||
        source.proxyReviewHash !== context.proxyReviewHash ||
        source.proxyArtifactId !== context.proxyArtifactId ||
        Math.abs(source.editPlan.fps - context.outputSpec.fps) > 0.01
      ) throw new DomainError('INVALID_RENDER_INPUT', 'Approved EditPlan or final OutputSpec is not safe to render')
      const renderSourceIds = source.renderSources.map((asset) => asset.artifactId)
      failureStage = 'rights'
      await assertRights(renderSourceIds, source.locale)
      failureStage = 'input-validation'
      const transitions = 'transitions' in source.editPlan ? source.editPlan.transitions : []
      const composition = 'composition' in source.editPlan ? source.editPlan.composition : undefined
      const musicTracks = 'audioTracks' in source.editPlan && Array.isArray(source.editPlan.audioTracks) ? source.editPlan.audioTracks : []
      const audioTimelineHash = musicTracks.length > 0
        ? createDirectedAudioTimelineHash({ fps: source.editPlan.fps, clips, musicTracks })
        : createEditorialAudioTimelineHash({ fps: source.editPlan.fps, clips })
      if ('audioTimelineHash' in source.editPlan && source.editPlan.audioTimelineHash !== audioTimelineHash) throw new DomainError('INVALID_RENDER_INPUT', 'Persisted Director audio timeline identity changed before final render')
      // W65/W65b. The geometry the approved proxy was drawn from (cues, CTA overlays, the placement plan, the persisted reframe plan),
      // derived by the same function from the same sealed source and the same planner. Only the canvas is the final's: the OutputSpec
      // the operation approved. The final decides its captions the way the proxy does, on the FINAL canvas, from the sealed face
      // windows of the sources the cut plays. A cue that cannot be certified in a free band is OMITTED (the renderer never draws it)
      // and LISTED as a review item in the receipt, never silently dropped: that is the sanctioned remedy, not a failure. What stops
      // the export before the encode is anything else - a hard issue, a band that is not free-certified under a placed cue, or a
      // burned caption that nothing would confirm in the delivered pixels. When the geometry cannot be derived the export stops here;
      // rendering the cut without its captions is not an option.
      const { subtitleCues, ctaOverlays, placementPlan, reframePlan } = await deriveEditorialRenderGeometry({
        source,
        canvas: { width: context.outputSpec.width, height: context.outputSpec.height },
        workspaceId: operation.workspaceId, projectId: context.projectId, clips,
        ...(composition ? { composition } : {}),
        ...(dependencies.faceEvidence ? { faceEvidence: dependencies.faceEvidence } : {}),
        clock,
        uncertifiedCues: 'omit-and-list',
      })
      const hardCaptionIssues = placementPlan.subtitleAnchorPlan?.issues.filter((issue) => issue.severity === 'hard') ?? []
      if (hardCaptionIssues.length > 0) {
        throw new DomainError('INVALID_RENDER_INPUT',
          `Final export has ${hardCaptionIssues.length} caption(s) that could not be placed (${[...new Set(hardCaptionIssues.map((issue) => issue.code))].join(', ')}); review is required`)
      }
      // Everything about the plan that does not need pixels. `completed` with no issues stands for "the delivered pixels agree".
      const preflight = certifyFinalCaptions({ plan: placementPlan, pixelCheck: { measurement: 'completed', issues: [] } })
      if (!preflight.admissible) {
        throw new DomainError('INVALID_RENDER_INPUT', `Final export captions are not certified (${preflight.failures.slice(0, 3).join('; ')})`)
      }
      const burnedCaptions = preflight.receipt.burned.length
      if (burnedCaptions > 0 && !dependencies.captionPixelCritic) {
        throw new DomainError('INVALID_RENDER_INPUT',
          `Final export would burn ${burnedCaptions} caption(s) but no caption pixel critic is available to confirm them in the delivered pixels`)
      }
      await enter('rendering')
      failureStage = 'source-materialization'
      const materializedSources = await Promise.all(source.renderSources.map((asset) =>
        dependencies.sources.materialize({
          operationId: operation.id,
          artifactKey: asset.artifactKey,
          sha256: asset.sha256,
          byteSize: asset.byteSize,
        })))
      failureStage = 'render'
      const renderRequest: Parameters<typeof dependencies.renderer.render>[0] = {
        operationId: operation.id,
        renderKind: 'final',
        sources: source.renderSources.map((asset, index) => ({
          artifactId: asset.artifactId,
          path: materializedSources[index]!.path,
          mediaType: asset.mediaType,
          ...(asset.mediaType === 'video' ? { colorPipelineCompilation: colorPipelines.get(asset.artifactId)! } : {}),
        })),
        lutPaths: materializedLut.lutPaths,
        ...(colorPlan ? { colorPlan } : {}),
        clips,
        audioTimelineHash,
        fps: context.outputSpec.fps,
        format: source.format,
        outputSpec: context.outputSpec,
        subtitleCues,
        ...(ctaOverlays.length ? { ctaOverlays } : {}),
        transitions,
        ...(musicTracks[0] ? { backgroundMusic: musicTracks[0] } : {}),
        ...(composition ? { composition } : {}),
        placementPlan,
        ...(reframePlan ? { reframePlan } : {}),
        signal: abortController.signal,
      }
      const render = () => dependencies.renderer.render(renderRequest)
      const rendered = dependencies.telemetry
        ? await runPublicOperationSpan({
            telemetry: dependencies.telemetry,
            record: claimed,
            spanKind: 'renderer',
            spanName: 'ffmpeg-final-export',
            clock,
            action: render,
            metrics: (result) => ({ outputBytes: result.byteSize }),
          })
        : await render()
      await enter('verifying')
      failureStage = 'output-verification'
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Final export lease was lost')
      // ---- W65b. Where the burned captions really are, measured on the bytes that were rendered ----
      // The control is the same encode without the cues; a final that burns nothing has nothing to confirm. Unlike the proxy, a
      // critic that was wired and could not measure does NOT leave a deliverable behind: the caption is not confirmed.
      let pixelCheck: FinalPixelCheck | null = null
      if (burnedCaptions > 0) {
        const controlOperationId = `${operation.id}-caption-control`
        try {
          const verification = await dependencies.captionPixelCritic!.verify({
            plan: placementPlan, deliveredPath: rendered.outputPath, signal: abortController.signal,
            renderControl: async () => {
              const control = await dependencies.renderer.render({ ...renderRequest, operationId: controlOperationId, subtitleCues: [] })
              return { path: control.outputPath }
            },
          })
          pixelCheck = Object.freeze({
            measurement: verification.measurement === 'completed' ? 'completed' as const : 'failed' as const,
            issues: verification.issues,
          })
        } catch (error) {
          if (abortController.signal.aborted) throw error
          pixelCheck = Object.freeze({ measurement: 'failed' as const, issues: [] })
        } finally {
          await dependencies.renderer.cleanup(controlOperationId).catch(() => undefined)
        }
      }
      const certification = certifyFinalCaptions({ plan: placementPlan, pixelCheck })
      // ---- W67. What the pixels of the delivered file say, by the independent critic; a blocked variant is not promoted ----
      let mp4Validator: { code: string; passed: boolean; message: string } | null = null
      let pendingAcknowledgement: Readonly<{ text: string; sha256: string; gateMessage: string }> | null = null
      const mp4Acknowledgement = dependencies.mp4ExportAcknowledgement ? parseMp4ExportAcknowledgement(dependencies.mp4ExportAcknowledgement) : null
      if (!dependencies.mp4PixelCritic) {
        // Not wired: the final is not approved by silence. Only an explicit acknowledgement (actor, time, reason) delivers it.
        const gate = mp4ExportGate({ report: null, acknowledgement: mp4Acknowledgement })
        let recorded = ''
        if (gate.allowed) {
          // The acknowledgement that delivers this final is a structured record (who, when, why, which operation), not validator text.
          // It is only BUILT here: it is stored once the final is actually delivered (after the codec/canvas/duration validators, the
          // rights check, the promotion and the artifact persistence), so an acknowledgement is never recorded for a final that failed.
          const unwiredPreset = readOutputFormatPreset(source.format as OutputAspectRatio)
          const acknowledgementRecord = mp4ExportAcknowledgementRecord({
            gate, workspaceId: operation.workspaceId, projectId: context.projectId, variantId: context.outputVariantId ?? sourceOutputVariantId(source),
            outputSpecId: unwiredPreset.spec.id, operationId: operation.id, reportHash: null,
          })
          const recordSha256 = createHash('sha256').update(acknowledgementRecord!.text).digest('hex')
          // until it is stored, the attempt says so explicitly: the acknowledgement was not used
          recorded = `; acknowledgement record ${recordSha256} not stored: the final was not delivered`
          pendingAcknowledgement = Object.freeze({ text: acknowledgementRecord!.text, sha256: recordSha256, gateMessage: gate.message })
        }
        mp4Validator = { code: 'FINAL_MP4_CRITIC', passed: gate.allowed, message: `${gate.message.slice(0, 230)}${recorded}.`.slice(0, 500) }
      } else {
        const outputPreset = readOutputFormatPreset(source.format as OutputAspectRatio)
        const outputSpecId = outputPreset.spec.id
        const verification = await verifyDeliveredMp4({
          critic: dependencies.mp4PixelCritic, renderer: dependencies.renderer, renderRequest, deliveredPath: rendered.outputPath,
          identity: {
            workspaceId: operation.workspaceId, projectId: context.projectId, projectVersionId: context.projectVersionId,
            variantId: context.outputVariantId ?? sourceOutputVariantId(source), outputSpecId, format: source.format, operationId: operation.id, renderInputHash: context.inputHash,
          },
          outputSpec: { width: context.outputSpec.width, height: context.outputSpec.height, safeArea: outputPreset.spec.safeArea },
          renderSources: source.renderSources, sourcePaths: materializedSources.map((materialized) => materialized.path), clips,
          overlays: { captions: burnedCaptions > 0, cta: ctaOverlays.length > 0 }, controlOperationPrefix: operation.id, signal: abortController.signal,
        })
        if (verification.measurement === 'failed') {
          mp4Validator = { code: 'FINAL_MP4_CRITIC', passed: false, message: `The MP4 pixel critic could not read the delivered file (${verification.failureCode}); a final is not delivered unverified.` }
        } else {
          const stored = await persistMp4QualityReport({ storage: dependencies.storage, workspaceId: operation.workspaceId, report: verification.verification.report })
          const formatReport = critiqueOutputFormat({
            outputSpecId, format: source.format as OutputAspectRatio, proxyHash: rendered.sha256, map: rendered.renderElementMap,
            placementPlanHash: placementPlan.placementPlanHash, reframePlanHash: reframePlan?.reframePlanHash ?? null,
            mp4PixelIssues: verification.verification.issues, mp4Evidence: verification.evidence,
          })
          const selection = selectExportableVariants([formatReport])
          const reported = selection.approvedOutputSpecIds.includes(outputSpecId)
          const blocking = selection.decisions.find((decision) => decision.outputSpecId === outputSpecId)?.blockingCodes ?? []
          // Fail closed on what the report could not establish (a failed oracle, ink over frames it could not read), not only on what it found.
          const gate = mp4ExportGate({ report: verification.verification.report, acknowledgement: mp4Acknowledgement })
          const approved = reported && gate.allowed
          const verdictText = !reported ? `MP4 critic blocked this variant (${blocking.join(', ')})`
            : !gate.allowed ? `MP4 critic could not fully judge this variant: ${gate.message}`
              : `MP4 critic did not block this variant${gate.blockers.length > 0 || gate.informational.length > 0 ? `; ${gate.message}` : ''}`
          // the tail that names the stored evidence is never the part that gets cut
          mp4Validator = {
            code: 'FINAL_MP4_CRITIC', passed: approved,
            message: `${verdictText.slice(0, 300)}; report ${verification.evidence.reportHash} stored as ${stored.key}.`.slice(0, 500),
          }
        }
      }
      const expectedFrames = clips.reduce(
        (total, clip) => total + clip.sourceOutFrame - clip.sourceInFrame,
        0,
      )
      const expectedDurationSeconds = expectedFrames / context.outputSpec.fps
      const durationToleranceSeconds = Math.max(0.1, 3 / context.outputSpec.fps)
      validators = [
        {
          code: 'FINAL_CODEC',
          passed: rendered.probe.codec === context.outputSpec.codec,
          message: `Video codec must be ${context.outputSpec.codec}.`,
        },
        {
          code: 'FINAL_AUDIO_CODEC',
          passed: rendered.probe.audioCodec === context.outputSpec.audioCodec,
          message: `Audio codec must be ${context.outputSpec.audioCodec}.`,
        },
        {
          code: 'FINAL_CONTAINER',
          passed: rendered.probe.container.includes(context.outputSpec.container),
          message: `Container must include ${context.outputSpec.container}.`,
        },
        {
          code: 'FINAL_CANVAS',
          passed: rendered.probe.width === context.outputSpec.width &&
            rendered.probe.height === context.outputSpec.height,
          message: 'Canvas must match the approved OutputSpec.',
        },
        {
          code: 'FINAL_FPS',
          passed: Math.abs(rendered.probe.fps - context.outputSpec.fps) <= 0.01,
          message: 'Frame rate must match the approved OutputSpec.',
        },
        {
          code: 'FINAL_DURATION',
          passed: Math.abs(rendered.probe.duration - expectedDurationSeconds) <= durationToleranceSeconds,
          message: 'Duration must match the compiled EditPlan.',
        },
        {
          code: 'FINAL_CHECKSUM',
          passed: /^[a-f0-9]{64}$/.test(rendered.sha256) &&
            Number.isSafeInteger(rendered.byteSize) &&
            rendered.byteSize > 0,
          message: 'Output must have a valid SHA-256 checksum and positive byte size.',
        },
        {
          code: 'FINAL_ELEMENT_MAP',
          passed: rendered.renderElementMap.proxyHash === rendered.sha256 &&
            rendered.renderElementMap.canvas.width === context.outputSpec.width &&
            rendered.renderElementMap.canvas.height === context.outputSpec.height &&
            rendered.renderElementMap.durationFrames === expectedFrames &&
            Math.abs(rendered.renderElementMap.fps - context.outputSpec.fps) <= 0.01,
          message: 'RenderElementMap must match final output identity and timing.',
        },
        {
          code: 'FINAL_CAPTION_CERTIFICATION',
          passed: certification.admissible,
          message: certification.admissible
            ? describeFinalCaptionCertification(certification.receipt)
            : `Burned captions are not certified: ${certification.failures.slice(0, 3).join('; ')}`.slice(0, 500),
        },
        ...(mp4Validator ? [mp4Validator] : []),
      ]
      if (validators.some((validator) => !validator.passed)) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'Final export does not match its approved OutputSpec')
      }
      failureStage = 'rights'
      await assertRights(renderSourceIds, source.locale)
      failureStage = 'output-promotion'
      await enter('persisting')
      const stored = await dependencies.storage.promoteDerived({
        workspaceId: operation.workspaceId,
        sourcePath: rendered.outputPath,
        sha256: rendered.sha256,
        extension: 'mp4',
        prefix: artifactOutputStoragePrefix('final-export', context.outputArtifactId),
      })
      if (
        stored.sha256 !== rendered.sha256 ||
        stored.byteSize !== rendered.byteSize
      ) throw new DomainError('RENDER_OUTPUT_INVALID', 'Promoted final output checksum or byte size changed')
      const toolDigest = createHash('sha256')
        .update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`)
        .digest('hex')
      const renderInput = createRenderInputSpec({
        schemaVersion: 'render-input/v1',
        renderer: {
          id: 'ffmpeg',
          version: 'static',
          digest: toolDigest,
        },
        composition: {
          id: 'apollo-editorial',
          version: 'v2',
          propsSchemaRef: 'apollo://render-props/apollo-editorial/v2',
        },
        plan: {
          id: source.editPlan.id,
          versionId: source.projectVersionId,
          hash: source.editPlanHash,
        },
        output: {
          id: `final-${context.outputSpec.aspectRatio.replace(':', '-')}`,
          locale: source.locale,
          aspectRatio: context.outputSpec.aspectRatio,
          width: context.outputSpec.width,
          height: context.outputSpec.height,
          fps: context.outputSpec.fps,
          safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
          durationInFrames: expectedFrames,
        },
        assets: [...source.renderSources.map((asset, ordinal) => ({
          id: `asset-${ordinal + 1}`,
          artifactId: asset.artifactId,
          artifactKey: asset.artifactKey,
          kind: asset.mediaType,
          role: asset.role,
          ordinal,
          sha256: asset.sha256,
          byteSize: asset.byteSize,
        })), ...(materializedLut.assets ?? (materializedLut.asset ? [materializedLut.asset] : [])).map((asset, index) => ({
          id: `asset-${source.renderSources.length + index + 1}`,
          artifactId: asset.artifactId,
          artifactKey: asset.artifactKey,
          kind: 'lut' as const,
          role: `creative-lut-${asset.parametersHash}`,
          ordinal: source.renderSources.length + index,
          sha256: asset.sha256,
          byteSize: asset.byteSize,
        }))],
        props: {
          renderSchemaVersion: 'apollo-editorial-final/v2',
          editPlan: source.editPlan,
          outputSpec: context.outputSpec,
          sourceArtifactIds: source.renderSources.map((asset) => asset.artifactId),
          audioTimelineHash,
          colorPipelineBindings: context.colorPipelineBindings,
          colorPipelineCompilations: [...colorPipelines.values()],
          colorPlan: colorPlan ?? null,
          lutBindings: (materializedLut.assets ?? (materializedLut.asset ? [materializedLut.asset] : [])).map((asset, index) => ({
            assetId: `asset-${source.renderSources.length + index + 1}`,
            artifactId: asset.artifactId,
            parametersHash: asset.parametersHash,
            cubeHash: asset.cubeHash,
            intensity: asset.intensity,
          })),
          // The placement the encode was decided with: a reconstruction renders the same captions in the same bands.
          placementPlan: placementPlan.subtitleAnchorPlan ? placementPlan : null,
          expectedOutputSha256: rendered.sha256,
          expectedOutputByteSize: rendered.byteSize,
          ffmpegBinarySha256: rendered.ffmpegBinarySha256 ?? null,
          colorPlanHash: colorPlan?.plan.planHash ?? null,
          compiledColorPlanManifestHash: colorPlan?.compiled.manifestHash ?? null,
          projectLutSelectionHash: materializedLut.selectionHash,
          materializedCubeHash: materializedLut.materializedCubeHash ?? null,
          materializedCubeHashes: materializedLut.materializedCubeHashes ?? [],
        },
      })
      const reconstructableManifest = createReconstructableMediaArtifactManifest({
        artifactKey: stored.key,
        artifactSha256: stored.sha256,
        byteSize: stored.byteSize,
        mediaType: 'video',
        container: 'mp4',
        recipe: {
          id: 'editorial-final',
          version: EDITORIAL_FINAL_RECIPE_VERSION,
          parameters: {
            assEmissionPolicy: ASS_EMISSION_POLICY,
            inputHash: context.inputHash,
            audioTimelineHash,
            projectVersionId: context.projectVersionId,
            projectVersionHash: context.projectVersionHash,
            editPlanSnapshotId: context.editPlanSnapshotId,
            directorRunId: context.directorRunId,
            qualitySnapshotId: context.qualitySnapshotId,
            qualitySnapshotHash: context.qualitySnapshotHash,
            proxyReviewId: context.proxyReviewId,
            proxyReviewHash: context.proxyReviewHash,
            proxyArtifactId: context.proxyArtifactId,
            outputSpec: context.outputSpec,
            approval: context.approval,
            colorPipelineBindings: context.colorPipelineBindings,
            colorPlanHash: colorPlan?.plan.planHash ?? null,
            compiledColorPlanManifestHash: colorPlan?.compiled.manifestHash ?? null,
            projectLutSelectionId: materializedLut.selectionId,
            projectLutSelectionHash: materializedLut.selectionHash,
            materializedCubeHash: materializedLut.materializedCubeHash ?? null,
            materializedCubeHashes: materializedLut.materializedCubeHashes ?? [],
            placementPlanHash: placementPlan.placementPlanHash,
            reframePlanHash: reframePlan?.reframePlanHash ?? null,
            subtitleAnchorPlanHash: placementPlan.subtitleAnchorPlan?.anchorPlanHash ?? null,
            perceptionTimelineHash: placementPlan.subtitleAnchorPlan?.perceptionTimelineHash ?? null,
            // W65b. What was burned, how each band was certified, and what was omitted and listed for review.
            captionCertificationPolicySha256: FINAL_CAPTION_CERTIFICATION_POLICY_SHA256,
            captionCertification: certification.receipt,
          },
        },
        sources: [
          ...source.renderSources.map((asset) => ({
            artifactKey: asset.artifactKey,
            sha256: asset.sha256,
            role: asset.role,
            execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } },
          })),
          ...(materializedLut.assets ?? []).map((asset) => ({
            artifactKey: asset.artifactKey,
            sha256: asset.sha256,
            role: `creative-lut:${asset.parametersHash}`,
            execution: { tool: { id: 'apollo-lut-materializer', version: '1', digest: asset.cubeHash } },
          })),
        ],
        probe: {
          width: rendered.probe.width,
          height: rendered.probe.height,
          duration: rendered.probe.duration,
          fps: rendered.probe.fps,
        },
        renderInput,
      })
      failureStage = 'artifact-persistence'
      const persisted = await dependencies.artifacts.persistOrReplay({
        workspaceId: operation.workspaceId,
        artifactId: context.outputArtifactId,
        manifestId: context.outputManifestId,
        lineageIds: source.renderSources.map((asset, index) =>
          `lineage-${createHash('sha256')
            .update(`${operation.workspaceId}:${context.inputHash}:${context.outputManifestId}:final:${asset.artifactId}:${index}`)
            .digest('hex')}`),
        manifest: reconstructableManifest.manifest,
        recipeParameters: reconstructableManifest.recipeParameters,
        renderInput: reconstructableManifest.renderInput,
        createdAt: clock().toISOString(),
      })
      if (persisted.artifactId !== context.outputArtifactId || persisted.manifestId !== context.outputManifestId) {
        await dependencies.projects.convergeOutputIdentity({
          workspaceId: operation.workspaceId,
          operationId: operation.id,
          reservedArtifactId: context.outputArtifactId,
          reservedManifestId: context.outputManifestId,
          persistedArtifactId: persisted.artifactId,
          persistedManifestId: persisted.manifestId,
          leaseOwner,
          attempt,
          now: clock().toISOString(),
        })
      }
      await dependencies.renderElementMaps.persistOrReplay({
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
        proxyArtifactId: persisted.artifactId,
        map: rendered.renderElementMap,
        createdAt: clock().toISOString(),
      })
      if (!(await heartbeat())) throw new DomainError('RENDER_EXECUTION_FAILED', 'Final export lease was lost')
      // W67. The final is delivered (promoted and persisted): the acknowledgement that lifted the critic's absence is recorded now, and
      // the attempt names where. A failure to store it fails the attempt rather than leaving a delivered final without its record.
      if (pendingAcknowledgement) {
        const acknowledgement = pendingAcknowledgement
        const recordedAcknowledgement = await persistMp4ExportAcknowledgement({ storage: dependencies.storage, workspaceId: operation.workspaceId, text: acknowledgement.text })
        const message = `${acknowledgement.gateMessage.slice(0, 230)}; acknowledgement record ${recordedAcknowledgement.sha256} stored as ${recordedAcknowledgement.key}.`.slice(0, 500)
        validators = validators.map((validator) => validator.code === 'FINAL_MP4_CRITIC' ? { ...validator, message } : validator)
      }
      const attemptCompletedAt = clock().toISOString()
      await dependencies.projects.recordAttempt({
        workspaceId: operation.workspaceId,
        operationId: operation.id,
        leaseOwner,
        attempt,
        status: 'promoted',
        validators,
        output: {
          artifactId: persisted.artifactId,
          manifestId: persisted.manifestId,
          sha256: stored.sha256,
          byteSize: stored.byteSize,
        },
        startedAt: attemptStartedAt,
        completedAt: attemptCompletedAt,
      })
      attemptRecorded = true
      await dependencies.catalogOutput({ workspaceId: operation.workspaceId, artifactId: persisted.artifactId, manifestId: persisted.manifestId })
      await dependencies.projects.attachCompletedOutput({
        workspaceId: operation.workspaceId,
        operationId: operation.id,
        projectId: context.projectId,
        projectVersionId: context.projectVersionId,
        outputArtifactId: persisted.artifactId,
        outputManifestId: persisted.manifestId,
        originalFileName: context.originalFileName,
        createdAt: clock().toISOString(),
      })
      stopHeartbeat()
      const succeeded = await withLeaseCommand(() =>
        dependencies.operations.succeed(command(clock())))
      if (!succeeded) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      return Object.freeze({ operationId: operation.id, status: 'succeeded' as const })
    } catch (error) {
      stopHeartbeat()
      if (leaseLost) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      const failedAt = clock()
      // An operator stopping this worker is not the export being rejected: it stays
      // retryable and comes back immediately, and the attempt record below says so
      // rather than blaming a validator that never ran.
      const shuttingDown = signal?.aborted === true
      const failure = shuttingDown ? { ...workerShutdownFailure(), stage: failureStage } : safeFailure(error, failureStage)
      if (!attemptRecorded) {
        if (validators.length === 0) {
          validators = [{
            code: 'FINAL_WORKFLOW',
            passed: false,
            message: 'Final workflow did not reach post-render validation.',
          }]
        }
        try {
          await dependencies.projects.recordAttempt({
            workspaceId: operation.workspaceId,
            operationId: operation.id,
            leaseOwner,
            attempt,
            status: 'failed',
            validators,
            error: { code: failure.code, message: failure.message, stage: failure.stage },
            startedAt: attemptStartedAt,
            completedAt: failedAt.toISOString(),
          })
          attemptRecorded = true
        } catch {
          leaseLost = true
          return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
        }
      }
      const nextAttemptAt = failure.retryable && attempt < operation.maxAttempts
        ? shuttingDown
          ? immediateNextAttemptAt(failedAt)
          : new Date(failedAt.getTime() + calculatePublicOperationRetryDelayMs({ attempt, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs })).toISOString()
        : undefined
      const failed = await withLeaseCommand(() =>
        dependencies.operations.failOrRetry({ ...command(failedAt), error: failure, ...(nextAttemptAt ? { nextAttemptAt } : {}) }))
      if (!failed) return Object.freeze({ operationId: operation.id, status: 'lease-lost' as const })
      if (failed.operation.status === 'failed') await dependencies.projects.markExportFailed({ workspaceId: operation.workspaceId, operationId: operation.id, projectId: context.projectId })
      return Object.freeze({ operationId: operation.id, status: failed.operation.status === 'retrying' ? 'retrying' as const : 'failed' as const })
    } finally {
      stopHeartbeat()
      ownerLink.dispose()
      await Promise.allSettled([
        dependencies.renderer.cleanup(operation.id),
        dependencies.luts.cleanup(operation.id),
        dependencies.sources.cleanup(operation.id),
      ])
    }
  }
}
