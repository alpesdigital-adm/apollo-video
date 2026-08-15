import type { EditorialCutClip } from '../apply-editorial-cut-command.ts'
import type { DirectedCtaOverlay, DirectedSubtitleCue, DirectedTransition } from '../../domain/director-run.ts'
import type { RenderElementMap } from '../../domain/review-system.ts'
import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'
import type { RenderPlacementPlanV1 } from '../../domain/render-placement-plan.ts'
import type { RenderReframePlanV1 } from '../../domain/render-reframe-plan.ts'

/**
 * 1.7.0 adds the materialized geometry sections (`placementPlan`, `reframePlan`) to the render
 * input and their content addresses to the recipe parameters. Both are additive: a render without
 * geometry produces the same filtergraph 1.6.0 produced.
 */
export const FFMPEG_EDITORIAL_RENDERER_VERSION = '1.7.0'
export const EDITORIAL_PROXY_RECIPE_VERSION = '1.7.0'
export const EDITORIAL_FINAL_RECIPE_VERSION = '1.3.0'

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
