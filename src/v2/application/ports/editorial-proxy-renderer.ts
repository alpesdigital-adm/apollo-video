import type { EditorialCutClip } from '../apply-editorial-cut-command.ts'
import type { DirectedSubtitleCue, DirectedTransition } from '../../domain/director-run.ts'

export interface EditorialProxyRenderResult {
  outputPath: string
  sha256: string
  byteSize: number
  probe: { width: number; height: number; duration: number; fps: number; codec: string; container: string }
}

export interface EditorialProxyRenderer {
  render(input: {
    operationId: string
    renderKind: 'proxy' | 'final'
    sourcePath: string
    clips: readonly Readonly<EditorialCutClip>[]
    fps: number
    format: string
    outputSpec?: { width: number; height: number; fps: number }
    subtitleCues?: readonly Readonly<DirectedSubtitleCue>[]
    transitions?: readonly Readonly<DirectedTransition>[]
    signal?: AbortSignal
  }): Promise<Readonly<EditorialProxyRenderResult>>
  cleanup(operationId: string): Promise<void>
}
