import type { PrismaClient } from '@prisma/client'

import type {
  RenderAssetAvailability,
  RenderInputAssetAvailability,
} from '../../application/ports/render-reconstruction-readiness.ts'
import type { RenderInputAsset } from '../../domain/render-input.ts'

type RenderAssetClient = Pick<PrismaClient, 'v2MediaArtifact'>

export class PrismaRenderInputAssetAvailability
  implements RenderInputAssetAvailability
{
  private readonly client: RenderAssetClient

  constructor(client: RenderAssetClient) {
    this.client = client
  }

  async inspect(
    workspaceId: string,
    asset: RenderInputAsset,
  ): Promise<RenderAssetAvailability> {
    if (!['video', 'audio', 'image'].includes(asset.kind)) {
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
