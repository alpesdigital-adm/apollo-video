import { DomainError } from '../domain/errors.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import {
  createRenderPlacementPlan,
  validateRenderPlacementPlan,
  type RenderPlacementRequestV1,
} from '../domain/render-placement-plan.ts'
import { validateRenderReframePlan } from '../domain/render-reframe-plan.ts'
import { emittedSubtitleTracks } from '../domain/subtitle-emission-tracks.ts'
import {
  requireSubtitlePresetSnapshot,
  SUBTITLE_STYLE_REGISTRY,
  subtitlePresetHash,
} from '../domain/subtitle-system.ts'
import type { ProjectProxyRenderSource } from './ports/project-proxy-render-repository.ts'

/**
 * The single authority for the geometry an editorial render draws: which caption cues are burned
 * in, which CTA overlays are drawn, the content-addressed placement plan (with the unknown-face
 * subtitle anchor plan) and the persisted reframe plan.
 *
 * The proxy render worker and the final export worker both derive it here, from the same sealed
 * source (the persisted EditPlan, its subtitle resolution, its trusted OCR envelope and its reframe
 * plan), so an approved proxy and the final cut made from it cannot disagree about what is on
 * screen. Nothing is invented: when a plan cannot be derived the call throws `INVALID_RENDER_INPUT`
 * and the caller must not render, and the renderer keeps refusing cues that arrive without the plan.
 *
 * Only the canvas differs between callers (the proxy canvas of the format, the OutputSpec canvas of
 * a final), because the placement plan is content-addressed against the pixels it will be drawn on.
 */
export function deriveEditorialRenderGeometry(input: Readonly<{
  source: Pick<ProjectProxyRenderSource, 'editPlan' | 'format' | 'trustedOcr' | 'subtitleResolution' | 'reframePlan'>
  canvas: Readonly<{ width: number; height: number }>
}>) {
  const { source } = input
  const cueTracks = emittedSubtitleTracks(source.editPlan.subtitleTracks).filter(
    (track) => track.cues.length > 0,
  )
  const subtitleResolution = source.subtitleResolution
  // An explicitly disabled style must never leak the EditPlan's cues into FFmpeg.
  // A renderable snapshot can have cues without a style resolution; its persisted
  // track preset only reserves geometry for the unknown-face review plan.
  const subtitleCues = subtitleResolution?.enabled === false
    ? [] : cueTracks.flatMap((track) => track.cues)
  const subtitlePresetId = subtitleResolution?.enabled
    ? subtitleResolution.presetId : subtitleCues.length ? cueTracks[0]?.presetId : null
  if (subtitleCues.length && (!subtitlePresetId || cueTracks.some(
    (track) => track.presetId !== subtitlePresetId,
  ))) throw new DomainError('INVALID_RENDER_INPUT', 'Subtitle cues require one consistent persisted preset')
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
  const placementElements: RenderPlacementRequestV1[] = ctaOverlays.map((overlay, index) => ({
    id: `cta-${index}-${overlay.id ?? index}`.slice(0, 96),
    kind: 'cta' as const, anchor: 'auto' as const, priority: 80, readingOrder: index,
    minWidth: 0.1, maxWidth: 0.9, minHeight: 0.05, maxHeight: 0.5,
    timeRange: { startFrame: overlay.startFrame, endFrame: overlay.endFrame },
  }))
  // Only the repository-resolved, scoped OCR envelope can supply text obstacles.
  // It does not establish facial coverage; every cue stays review-required.
  const perceptionTimeline = source.trustedOcr?.timeline
  const placementPlan = createRenderPlacementPlan({
    format: source.format as OutputAspectRatio,
    canvas: { width: input.canvas.width, height: input.canvas.height },
    durationFrames,
    // The subtitle band is reserved from the *resolved* preset, so a CTA is never solved into
    // the rows the subtitles already own — and never from a rectangle authored here.
    subtitlePresetId,
    elements: placementElements,
    ...(subtitleCues.length ? {
      subtitleAnchor: {
        fps: source.editPlan.fps,
        cues: subtitleCues.map((cue) => ({ id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame })),
        faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' },
        ...(source.trustedOcr ? { ocrEvidence: {
          envelopeId: source.trustedOcr.envelopeId,
          envelopeHash: source.trustedOcr.envelopeHash,
          inputVersionId: source.trustedOcr.inputVersionId,
          timeMapHash: source.trustedOcr.timeMapHash,
        } } : {}),
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
  return Object.freeze({ subtitleCues, subtitlePresetId, subtitleResolution, ctaOverlays, placementPlan, reframePlan })
}
