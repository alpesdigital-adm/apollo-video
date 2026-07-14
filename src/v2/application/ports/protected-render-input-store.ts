import type { RenderInputSpecV1 } from '../../domain/render-input.ts'

export interface ProtectedRenderInputStore {
  read(
    workspaceId: string,
    ref: string,
    inputHash: string,
  ): Promise<RenderInputSpecV1 | null>
}
