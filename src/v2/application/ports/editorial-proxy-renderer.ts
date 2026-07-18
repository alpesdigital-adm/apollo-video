import type { EditorialCutClip } from '../apply-editorial-cut-command.ts'

export interface EditorialProxyRenderResult {
  outputPath: string
  sha256: string
  byteSize: number
  probe: { width: number; height: number; duration: number; fps: number; codec: string; container: string }
}

export interface EditorialProxyRenderer {
  render(input: {
    operationId: string
    sourcePath: string
    clips: readonly Readonly<EditorialCutClip>[]
    fps: number
    format: string
    signal?: AbortSignal
  }): Promise<Readonly<EditorialProxyRenderResult>>
  cleanup(operationId: string): Promise<void>
}
