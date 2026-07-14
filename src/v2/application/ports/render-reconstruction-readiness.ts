import type {
  RenderInputAsset,
  RenderInputSpecV1,
} from '../../domain/render-input.ts'

export type RenderAssetAvailabilityCode =
  | 'ASSET_NOT_FOUND'
  | 'ASSET_UNAVAILABLE'
  | 'ASSET_IDENTITY_MISMATCH'
  | 'ASSET_KIND_UNSUPPORTED'

export interface RenderAssetAvailability {
  available: boolean
  code?: RenderAssetAvailabilityCode
}

export interface RenderInputAssetAvailability {
  inspect(
    workspaceId: string,
    asset: RenderInputAsset,
  ): Promise<RenderAssetAvailability>
}

export interface RenderTargetRegistry {
  supportsRenderer(renderer: RenderInputSpecV1['renderer']): boolean
  supportsComposition(composition: RenderInputSpecV1['composition']): boolean
}
