import type { EditorialCutClip } from '../apply-editorial-cut-command.ts'
import type { DirectedCtaOverlay, DirectedSubtitleCue, DirectedTransition } from '../../domain/director-run.ts'
import type { RenderElementMap } from '../../domain/review-system.ts'
import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'
import type { RenderPlacementPlanV1 } from '../../domain/render-placement-plan.ts'
import type { RenderReframePlanV1 } from '../../domain/render-reframe-plan.ts'
import type { ProjectColorPlan } from '../../domain/project-color-plan.ts'

/**
 * 1.7.0 adds the materialized geometry sections (`placementPlan`, `reframePlan`) to the render
 * input and their content addresses to the recipe parameters. Both are additive: a render without
 * geometry produces the same filtergraph 1.6.0 produced.
 *
 * 1.8.0 lets the placement plan carry a `subtitleAnchorPlan` (F1.036 / FR-173). When it is present
 * the ASS events are positioned on the decided band instead of the Director's fallback anchor, and
 * a cue with no safe band is not written at all — so the same cue list can produce different
 * pixels. That is a new recipe, not a variation of 1.7.0: proxies are addressed by recipe version,
 * and reusing a 1.7.0 proxy for an anchored render would show subtitles in the wrong place.
 */
export const FFMPEG_EDITORIAL_RENDERER_VERSION = '1.9.0'
export const EDITORIAL_PROXY_RECIPE_VERSION = '1.9.0'
export const EDITORIAL_FINAL_RECIPE_VERSION = '1.4.0'

/** Absolute path + digest of one asset a drawable placement is allowed to read. */
export interface EditorialPlacementAsset {
  elementId: string
  path: string
  sha256: string
}

export interface EditorialProxyRenderResult {
  outputPath: string
  sha256: string
  byteSize: number
  probe: { width: number; height: number; duration: number; fps: number; codec: string; audioCodec: string; container: string }
  renderElementMap: Readonly<RenderElementMap>
}

export interface EditorialProxyRenderer {
  render(input: {
    operationId: string
    renderKind: 'proxy' | 'final'
    sources: readonly Readonly<{
      artifactId: string
      path: string
      mediaType: 'video' | 'audio'
      colorPipelineCompilation?: Readonly<ColorPipelineCompilation>
    }>[]
    lutPaths: Readonly<Record<string, string>>
    /** Version-effective, content-addressed ColorPlan. When present every clip must bind exactly one compiled target. */
    colorPlan?: Readonly<ProjectColorPlan>
    clips: readonly Readonly<EditorialCutClip>[]
    /** Canonical frame-first audio identity. Workers must provide it; direct
     * adapter diagnostics may omit it and let the adapter derive the same hash. */
    audioTimelineHash?: string
    fps: number
    format: string
    outputSpec?: { width: number; height: number; fps: number }
    subtitleCues?: readonly Readonly<DirectedSubtitleCue>[]
    ctaOverlays?: readonly Readonly<DirectedCtaOverlay>[]
    transitions?: readonly Readonly<DirectedTransition>[]
    composition?: Readonly<{ foregroundScale: number; verticalPosition: number }>
    /** Content-addressed placement geometry; drawable entries require a matching `placementAssets` row. */
    placementPlan?: Readonly<RenderPlacementPlanV1>
    placementAssets?: readonly Readonly<EditorialPlacementAsset>[]
    /** Content-addressed crop trajectory, one range per clip, half-open in timeline frames. */
    reframePlan?: Readonly<RenderReframePlanV1>
    rangeReuse?: Readonly<{
      schemaVersion: 'project-proxy-range-reuse/v1'
      commandId: string
      impactHash: string
      baseVersionId: string
      ranges: readonly Readonly<{ startFrame: number; endFrame: number }>[]
      artifactId: string
      manifestId: string
      path: string
      sha256: string
      byteSize: number
    }>
    signal?: AbortSignal
  }): Promise<Readonly<EditorialProxyRenderResult>>
  cleanup(operationId: string): Promise<void>
}
