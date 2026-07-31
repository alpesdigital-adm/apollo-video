import type { PrismaClient } from '../../../generated/prisma-v2/index.js'

import type {
  RenderInputAssetResolver,
  ResolvedRenderInputAsset,
} from '../application/ports/render-input-asset-resolver.ts'
import { DomainError } from '../domain/errors.ts'
import type { RenderInputAsset } from '../domain/render-input.ts'
import type { S3RenderInputObjectClient } from './s3-render-input-object-client.ts'

type S3ArtifactClient = Pick<PrismaClient, 'v2MediaArtifact'>

function failure(reasonCode: string, asset: RenderInputAsset): DomainError {
  return new DomainError(
    'MATERIALIZATION_REVALIDATION_FAILED',
    'S3 render asset could not be materialized with its immutable identity',
    { reasonCode, assetOrdinal: asset.ordinal, assetKind: asset.kind },
  )
}

export class S3ArtifactRenderInputResolver implements RenderInputAssetResolver {
  private readonly client: S3ArtifactClient
  private readonly workspaceId: string
  private readonly objects: S3RenderInputObjectClient
  private readonly nonMediaResolver: RenderInputAssetResolver
  private readonly validUntil: string

  constructor(
    client: S3ArtifactClient,
    workspaceId: string,
    objects: S3RenderInputObjectClient,
    nonMediaResolver: RenderInputAssetResolver,
    validUntil: string,
  ) {
    this.client = client
    this.workspaceId = workspaceId
    this.objects = objects
    this.nonMediaResolver = nonMediaResolver
    this.validUntil = validUntil
  }

  async resolve(asset: RenderInputAsset): Promise<ResolvedRenderInputAsset> {
    if (asset.kind === 'lut') return this.nonMediaResolver.resolve(asset)
    if (!['video', 'audio', 'image'].includes(asset.kind)) throw failure('ASSET_KIND_UNSUPPORTED', asset)
    const stored = await this.client.v2MediaArtifact.findFirst({
      where: { id: asset.artifactId, workspaceId: this.workspaceId },
    })
    if (!stored) throw failure('ASSET_NOT_FOUND', asset)
    if (stored.status !== 'available') throw failure('ASSET_UNAVAILABLE', asset)
    if (
      stored.artifactKey !== asset.artifactKey ||
      stored.sha256 !== asset.sha256 ||
      stored.byteSize !== BigInt(asset.byteSize) ||
      stored.mediaType !== asset.kind
    ) throw failure('ASSET_IDENTITY_MISMATCH', asset)
    try {
      return await this.objects.resolve({
        artifactKey: asset.artifactKey,
        sha256: asset.sha256,
        byteSize: asset.byteSize,
        validUntil: this.validUntil,
      })
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === 'MATERIALIZATION_AUTHORIZATION_EXPIRED') throw error
        throw failure(String(error.details.reasonCode ?? 'STORAGE_READ_FAILED'), asset)
      }
      throw failure('STORAGE_READ_FAILED', asset)
    }
  }
}
