import type { EditorialCutClip } from '../apply-editorial-cut-command.ts'
import type { DirectedSubtitleCue, DirectedTransition } from '../../domain/director-run.ts'
import type { RenderElementMap } from '../../domain/review-system.ts'
import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'

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
    fps: number
    format: string
    outputSpec?: { width: number; height: number; fps: number }
    subtitleCues?: readonly Readonly<DirectedSubtitleCue>[]
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
