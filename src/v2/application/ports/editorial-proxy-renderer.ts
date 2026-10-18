import type { EditorialCutClip } from '../apply-editorial-cut-command.ts'
import type { DirectedCtaOverlay, DirectedMusicTrack, DirectedSubtitleCue, DirectedTransition } from '../../domain/director-run.ts'
import type { RenderElementMap } from '../../domain/review-system.ts'
import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'
import type { RenderPlacementPlan } from '../../domain/render-placement-plan.ts'
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
 *
 * 1.10.0 binds each ColorPlan target to its exact resolved pipeline and materialized creative-LUT
 * intensity. Final recipe 1.5.0 carries the same target-scoped color lineage.
 * Renderer 1.12.0 requires a v2 unknown-face plan for every rendered cue. Proxy recipe 1.13.0
 * and final recipe 1.8.0 distinguish these suppressed pixels from older bottom-anchor output;
 * an older proxy cannot be reused across the safety-policy change.
 */
// 1.13.0 pinned ass-frame-clock/v1 (exact-rational floor boundaries), reprobated by the W69 v5 pixel proof:
// vf_subtitles hands libass trunc(pts * q2d * 1000) in binary64, which is one millisecond low on some frames.
// 1.14.0 pins ass-frame-clock/v2: the stream ends in `fps=<rate>` before libass, every cue boundary is an
// integer centisecond inside the window of the frame it starts or ends at, an empty window is a typed refusal
// before any I/O, each clipped/rebased fragment is bound in its own clock, and C0/DEL text still fails closed.
// 1.15.0 pins ass-frame-clock/v3: the stream ends in `settb=1/<rate>,setpts=N` before libass instead of `fps=<rate>`.
// The v2 stage dropped the final frame after `overlay=shortest=1` on FFmpeg 6.1.1 (T-FR-227: 899 of 900 frames, every
// rate from 24 to 120 fps); the v3 stage gives libass the same (pts = frame index, time base 1/rate) and never changes the
// frame count. Proxy recipe 1.16.0 and final recipe 1.11.0: a proxy or final of the v2 stage is one frame short on that
// FFmpeg and must not be reused.
// 1.16.0 (W65): the renderer accepts `subtitle-anchor-plan/v3`, so a cue whose band is certified on the variant's canvas is
// DRAWN where the plan put it (it used to be suppressed unconditionally), and it rebuilds the caption projection from the
// sources it probed and refuses a plan decided on anything else. Proxy recipe 1.17.0 and final recipe 1.12.0: the same cue
// list now produces different pixels, so a proxy or final of 1.15.0/1.16.0/1.11.0 must not be reused for it.
// 1.13.0 (final recipe only, W65b): a final records the caption certification it was admitted under - the pinned policy digest and
// the receipt of what was burned (and how each band was certified) and what was omitted and listed for review - and its pre-render
// identity binds that policy. The renderer and the pixels do not change, so the renderer version and the proxy recipe stay.
// These affect pixels; renderer digest and both recipe versions invalidate previous reuse.
export const FFMPEG_EDITORIAL_RENDERER_VERSION = '1.16.0'
export const EDITORIAL_PROXY_RECIPE_VERSION = '1.17.0'
export const EDITORIAL_FINAL_RECIPE_VERSION = '1.13.0'

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
  ffmpegBinarySha256?: string
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
    backgroundMusic?: Readonly<DirectedMusicTrack>
    composition?: Readonly<{ foregroundScale: number; verticalPosition: number }>
    /** Content-addressed placement geometry; drawable entries require a matching `placementAssets` row. */
    placementPlan?: Readonly<RenderPlacementPlan>
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
