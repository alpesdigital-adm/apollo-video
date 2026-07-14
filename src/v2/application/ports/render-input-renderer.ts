import type { MaterializedRenderInputV1 } from '../../domain/render-input.ts'

export interface StagedRenderReceipt {
  schemaVersion: 'staged-render-receipt/v1'
  stageId: string
  inputHash: string
  outputSha256: string
  byteSize: number
  width: number
  height: number
  fps: number
  durationInFrames: number
  codec: 'h264'
  container: 'mp4'
}

export interface CommittedRenderReceipt
  extends Omit<StagedRenderReceipt, 'schemaVersion'> {
  schemaVersion: 'committed-render-receipt/v1'
  committedAt: string
}

export interface StagedRender {
  readonly receipt: Readonly<StagedRenderReceipt>
  commit(): Promise<Readonly<CommittedRenderReceipt>>
  discard(): Promise<void>
  toJSON(): Readonly<StagedRenderReceipt>
}

export interface RenderInputRenderer {
  stage(
    input: MaterializedRenderInputV1,
    request: { outputKey: string; signal?: AbortSignal },
  ): Promise<StagedRender>
}
