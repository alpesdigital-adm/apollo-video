import type { RenderInputAsset } from '../../domain/render-input.ts'

export interface ResolvedRenderInputAsset {
  uri: string
  sha256: string
  byteSize: number
}

export interface RenderInputAssetResolver {
  resolve(asset: RenderInputAsset): Promise<ResolvedRenderInputAsset>
}
