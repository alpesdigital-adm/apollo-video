import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  RenderAssetAvailability,
  RenderInputAssetAvailability,
} from '../../application/ports/render-reconstruction-readiness.ts'
import type { RenderInputAsset } from '../../domain/render-input.ts'
import { materializeRenderInputLut, parseRenderInputLutIdentity } from '../../domain/render-input-lut-asset.ts'
import type { WorkspaceLutRepository } from '../../application/ports/workspace-lut-repository.ts'

type RenderAssetClient = Pick<PrismaClient, 'v2MediaArtifact'>

export class PrismaRenderInputAssetAvailability
  implements RenderInputAssetAvailability
{
  private readonly client: RenderAssetClient
  private readonly luts?: WorkspaceLutRepository

  constructor(client: RenderAssetClient, luts?: WorkspaceLutRepository) {
    this.client = client
    this.luts = luts
  }

  async inspect(
    workspaceId: string,
    asset: RenderInputAsset,
  ): Promise<RenderAssetAvailability> {
    if (asset.kind === 'lut') {
      const identity = parseRenderInputLutIdentity(asset)
      if (!identity || !this.luts) return { available: false, code: 'ASSET_KIND_UNSUPPORTED' }
      const version = await this.luts.readVersion({ workspaceId, lutId: identity.lutId, version: identity.version })
      if (!version) return { available: false, code: 'ASSET_NOT_FOUND' }
      return materializeRenderInputLut(asset, version)
        ? { available: true }
        : { available: false, code: 'ASSET_IDENTITY_MISMATCH' }
    }
    if (!['video', 'audio', 'image', 'font', 'data'].includes(asset.kind)) {
      return { available: false, code: 'ASSET_KIND_UNSUPPORTED' }
    }
    const stored = await this.client.v2MediaArtifact.findFirst({
      where: { id: asset.artifactId, workspaceId },
    })
    if (!stored) return { available: false, code: 'ASSET_NOT_FOUND' }
    if (stored.status !== 'available') {
      return { available: false, code: 'ASSET_UNAVAILABLE' }
    }
    if (
      stored.artifactKey !== asset.artifactKey ||
      stored.sha256 !== asset.sha256 ||
      stored.byteSize !== BigInt(asset.byteSize) ||
      stored.mediaType !== asset.kind
    ) {
      return { available: false, code: 'ASSET_IDENTITY_MISMATCH' }
    }
    return { available: true }
  }
}
