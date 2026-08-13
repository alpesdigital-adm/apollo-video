import type { EditorialCutClip } from '../apply-editorial-cut-command.ts'
import type { DirectedCtaOverlay, DirectedSubtitleCue, DirectedTransition } from '../../domain/director-run.ts'
import type { RenderElementMap } from '../../domain/review-system.ts'
import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'

export const FFMPEG_EDITORIAL_RENDERER_VERSION = '1.6.0'
export const EDITORIAL_PROXY_RECIPE_VERSION = '1.6.0'
export const EDITORIAL_FINAL_RECIPE_VERSION = '1.3.0'

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
