import { captionLayoutOverflows } from '../domain/caption-burn-layout.ts'
import { DomainError } from '../domain/errors.ts'
import { assertOutputIsProduced, assertReframePlanCoherentWithLayout, assertReframePlanForFill } from '../domain/editorial-policy-resolution.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import {
  validateRenderPlacementPlan,
  type RenderPlacementRequestV1,
} from '../domain/render-placement-plan.ts'
import { validateRenderReframePlan } from '../domain/render-reframe-plan.ts'
import { sourceOutputVariantId } from './project-render-sources.ts'
import { emittedSubtitleTracks } from '../domain/subtitle-emission-tracks.ts'
import { resolveSubtitleOverridesForRender } from '../domain/subtitle-segment-override.ts'
import {
  requireSubtitlePresetSnapshot,
  SUBTITLE_STYLE_REGISTRY,
  subtitlePresetHash,
} from '../domain/subtitle-system.ts'
import { planCaptionPlacement, type CaptionPlacementInput } from './plan-caption-placement.ts'
import type { FaceSourceWindowEvidenceReader } from './ports/face-source-window-evidence-reader.ts'
import type { ProjectProxyRenderSource } from './ports/project-proxy-render-repository.ts'

/**
 * The single authority for the geometry an editorial render draws: which caption cues are burned
 * in, which CTA overlays are drawn, the content-addressed placement plan (with the subtitle anchor
 * plan decided from the sealed face windows of the sources the cues play) and the persisted reframe plan.
 *
 * The proxy render worker and the final export worker both derive it here, from the same sealed
 * source (the persisted EditPlan, its subtitle resolution, its trusted OCR envelope and its reframe
 * plan) and from the same planner, so an approved proxy and the final cut made from it cannot
 * disagree about what is on screen. Nothing is invented: when a plan cannot be derived the call
 * throws `INVALID_RENDER_INPUT` and the caller must not render, and the renderer keeps refusing
 * cues that arrive without the plan.
 *
 * Only the canvas differs between callers (the proxy canvas of the format, the OutputSpec canvas of
 * a final), because the placement plan is content-addressed against the pixels it will be drawn on.
 *
 * The placement is decided by `planCaptionPlacement` (W65/W65b): the caption bands are judged against the
 * source-to-canvas projection of THIS render's clips and the face evidence of each source, keyed by the
 * source's own frames. `uncertifiedCues` is what a cue that cannot be certified costs: `block` (the default)
 * or, under the final's rule, `omit-and-list`.
 */
export async function deriveEditorialRenderGeometry(input: Readonly<{
  source: Pick<
    ProjectProxyRenderSource,
    'editPlan' | 'format' | 'trustedOcr' | 'subtitleResolution' | 'reframePlan' | 'reframeIssues' | 'renderSources' | 'sourceArtifactId' | 'outputConsumption' | 'subtitleOverrides' | 'policyResolution'
  >
  canvas: Readonly<{ width: number; height: number }>
  workspaceId: string
  /** The project being rendered: it reads the face evidence (the source must be attached to it) under its own locale. */
  projectId: string
  clips: CaptionPlacementInput['clips']
  composition?: CaptionPlacementInput['composition']
  faceEvidence?: FaceSourceWindowEvidenceReader
  clock: () => Date
  uncertifiedCues?: CaptionPlacementInput['uncertifiedCues']
  /**
   * W70 readiness (R3). What a DRAWN caption whose text does not fit its certified band costs (`caption-burn-layout.ts`). `draw-and-block`
   * (the default; the proxy): the cue is drawn as it is and returned in `captionOverflows`, for the caller to make a hard issue of it.
   * `omit-and-list` (the final, W65b rule): the cue is planned and drawn no more - it is left out of `subtitleCues` and of the plan - and
   * returned in `captionOverflows`, for the caller to list it as a review item.
   */
  captionTextOverflow?: 'draw-and-block' | 'omit-and-list'
}>) {
  const { source } = input
  const cueTracks = emittedSubtitleTracks(source.editPlan.subtitleTracks).filter(
    (track) => track.cues.length > 0,
  )
  const subtitleResolution = source.subtitleResolution
  // An explicitly disabled style must never leak the EditPlan's cues into FFmpeg.
  // A renderable snapshot can have cues without a style resolution; its persisted
  // track preset only reserves geometry for the review plan.
  const compiledCues = subtitleResolution?.enabled === false
    ? [] : cueTracks.flatMap((track) => track.cues)
  const subtitlePresetId = subtitleResolution?.enabled
    ? subtitleResolution.presetId : compiledCues.length ? cueTracks[0]?.presetId : null
  if (compiledCues.length && (!subtitlePresetId || cueTracks.some(
    (track) => track.presetId !== subtitlePresetId,
  ))) throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle cues require one consistent persisted preset')
  // W68. The persisted per-segment exceptions of THIS output (text, visibility, style, and the band an operator pinned a cue to). A cue
  // the operator hid is neither drawn nor planned; a pinned band is still decided by the evidence (see `pinnedAnchor`).
  const overrideResolution = compiledCues.length && source.subtitleOverrides?.length
    ? resolveSubtitleOverridesForRender({ cues: compiledCues, overrides: source.subtitleOverrides, variantId: sourceOutputVariantId(source) })
    : null
  const subtitleOverrideReceipt = overrideResolution?.receipt ?? null
  const subtitleCues = overrideResolution
    ? overrideResolution.cues.map((cue) => {
        const preset = subtitleOverrideReceipt?.stylePresets[cue.id]
        return preset ? Object.freeze({ ...cue, presetId: preset }) : cue
      })
    : compiledCues
  const ctaOverlays = (source.editPlan.overlayTracks ?? []).filter(
    (track) => 'kind' in track && track.kind === 'cta',
  )
  const durationFrames = source.editPlan.durationFrames
  if (subtitleResolution?.enabled) {
    // Fail closed on coherence between the identity the resolution carries and the tokens it
    // carries. When the resolution names the *current* registry, the tokens must still be the
    // ones the registry holds; when it names an older one, the content-addressed snapshot is
    // the authority and the render reproduces what it was compiled to draw (FR-172).
    if (!subtitleResolution.presetSnapshot) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Enabled subtitle resolution carries no materialized preset snapshot')
    }
    const snapshot = requireSubtitlePresetSnapshot(subtitleResolution.presetSnapshot)
    if (snapshot.presetId !== subtitleResolution.presetId || snapshot.presetHash !== subtitleResolution.presetHash ||
        snapshot.registryHash !== subtitleResolution.registryHash) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Persisted subtitle preset snapshot does not match its resolution')
    }
    if (subtitleResolution.registryHash === SUBTITLE_STYLE_REGISTRY.registryHash &&
        subtitleResolution.presetHash !== subtitlePresetHash(subtitleResolution.presetId)) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Persisted subtitle resolution drifted from the subtitle style registry')
    }
  }
  const reframePlan = source.reframePlan
  if (reframePlan) {
    validateRenderReframePlan(reframePlan)
    // W66r. The plan names the STABLE output variant the render is sealed to; the aspect ratio only has to agree. Two outputs of one aspect
    // ratio can never be told apart by it, which is exactly what keying the plan by format used to allow.
    if (
      reframePlan.variantId !== sourceOutputVariantId(source) ||
      reframePlan.format !== source.format ||
      reframePlan.durationFrames !== durationFrames ||
      Math.abs(reframePlan.fps - source.editPlan.fps) > 0.01
    ) throw new DomainError('INVALID_RENDER_INPUT', 'Persisted reframe plan does not describe this render')
  }
  // ADR-160. A request that fills the frame of THIS output asks for the reframe trajectory of that output. Rendering it without that plan would draw the whole
  // frame over a backdrop - something the request did not ask for, told to nobody - so the render is refused and says what is missing.
  if (source.policyResolution?.policies.layout.value.perOutput !== undefined) {
    assertOutputIsProduced(source.policyResolution, sourceOutputVariantId(source))
    assertReframePlanForFill(source.policyResolution, sourceOutputVariantId(source), reframePlan !== undefined)
    assertReframePlanCoherentWithLayout(source.policyResolution, sourceOutputVariantId(source), reframePlan)
  }
  const placementElements: RenderPlacementRequestV1[] = ctaOverlays.map((overlay, index) => ({
    id: `cta-${index}-${overlay.id ?? index}`.slice(0, 96),
    kind: 'cta' as const, anchor: 'auto' as const, priority: 80, readingOrder: index,
    minWidth: 0.1, maxWidth: 0.9, minHeight: 0.05, maxHeight: 0.5,
    timeRange: { startFrame: overlay.startFrame, endFrame: overlay.endFrame },
  }))
  const plan = (cues: typeof subtitleCues) => planCaptionPlacement(
    { clock: input.clock, ...(input.faceEvidence ? { faceEvidence: input.faceEvidence } : {}) },
    {
      workspaceId: input.workspaceId, projectId: input.projectId,
      format: source.format as OutputAspectRatio,
      canvas: { width: input.canvas.width, height: input.canvas.height },
      editPlan: source.editPlan, clips: input.clips, ...(input.composition ? { composition: input.composition } : {}),
      renderSources: source.renderSources.map((asset) => ({
        artifactId: asset.artifactId, sha256: asset.sha256, mediaType: asset.mediaType, ...(asset.probe ? { probe: asset.probe } : {}),
      })),
      ...(reframePlan ? { reframePlan } : {}),
      subtitleCues: cues.map((cue) => ({
        id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame,
        ...(subtitleOverrideReceipt?.pinnedAnchors[cue.id] ? { pinnedAnchor: subtitleOverrideReceipt.pinnedAnchors[cue.id]! } : {}),
      })),
      // The subtitle band is reserved from the *resolved* preset, so a CTA is never solved into the rows the subtitles
      // already own - and never from a rectangle authored here.
      subtitlePresetId, placementElements,
      // Only the repository-resolved, scoped OCR envelope can supply text obstacles. It does not establish facial
      // coverage: that comes from the sealed face windows of the sources, or the cue is not drawn.
      ...(source.trustedOcr ? { trustedOcr: source.trustedOcr } : {}),
      primarySourceArtifactId: source.sourceArtifactId,
      ...(input.uncertifiedCues ? { uncertifiedCues: input.uncertifiedCues } : {}),
    },
  )
  const overflowsOf = (planned: Awaited<ReturnType<typeof plan>>, cues: typeof subtitleCues) =>
    captionLayoutOverflows({ anchorPlan: planned.placementPlan.subtitleAnchorPlan, cues, canvas: input.canvas })
  let planned = await plan(subtitleCues)
  let drawnCues = subtitleCues
  // W70 readiness (R3). Known before anything is rendered, from the same layout the renderer draws with.
  const captionOverflows = overflowsOf(planned, subtitleCues)
  if (captionOverflows.length > 0 && input.captionTextOverflow === 'omit-and-list') {
    // The cues are planned again without the ones that do not fit, so the plan, the renderer and the certification agree that they are not
    // burned. The five bands share one box, so whether a cue fits does not depend on where the others went: no cue that fitted stops fitting.
    const omitted = new Set(captionOverflows.map((overflow) => overflow.cueId))
    drawnCues = subtitleCues.filter((cue) => !omitted.has(cue.id))
    planned = await plan(drawnCues)
    if (overflowsOf(planned, drawnCues).length > 0) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Captions that do not fit their band remain after the ones that did not fit were omitted')
    }
  }
  const { placementPlan, requiredFaceWindows } = planned
  validateRenderPlacementPlan(placementPlan)
  return Object.freeze({
    subtitleCues: drawnCues, subtitlePresetId, subtitleResolution, ctaOverlays, placementPlan, reframePlan, reframeIssues: source.reframeIssues ?? [], requiredFaceWindows,
    subtitleOverrideReceipt, captionOverflows,
  })
}
