import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PrismaClient } from '../../../generated/prisma-v2/index.js'

import type {
  RenderInputAssetResolver,
  ResolvedRenderInputAsset,
} from '../application/ports/render-input-asset-resolver.ts'
import { DomainError } from '../domain/errors.ts'
import type { RenderInputAsset } from '../domain/render-input.ts'

type LocalArtifactClient = Pick<PrismaClient, 'v2MediaArtifact'>

function materializationFailure(
  reasonCode: string,
  asset: RenderInputAsset,
): DomainError {
  return new DomainError(
    'MATERIALIZATION_REVALIDATION_FAILED',
    'Render asset bytes could not be materialized with their immutable identity',
    {
      reasonCode,
      assetOrdinal: asset.ordinal,
      assetKind: asset.kind,
    },
  )
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child.length > 0 && child !== '..' && !child.startsWith(`..\\`) && !child.startsWith('../') && !isAbsolute(child)
}

export class LocalArtifactRenderInputResolver implements RenderInputAssetResolver {
  private readonly client: LocalArtifactClient
  private readonly root: string
  private readonly workspaceId: string

  constructor(
    client: LocalArtifactClient,
    options: { root: string; workspaceId: string },
  ) {
    this.client = client
    this.root = options.root.trim()
    this.workspaceId = options.workspaceId.trim()
    if (!this.root || !isAbsolute(this.root)) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Local artifact storage root must be an absolute path',
      )
    }
    if (this.workspaceId.length < 3 || this.workspaceId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'workspaceId must contain 3 to 128 characters')
    }
  }

  async resolve(asset: RenderInputAsset): Promise<ResolvedRenderInputAsset> {
    try {
      if (!['video', 'audio', 'image'].includes(asset.kind)) {
        throw materializationFailure('ASSET_KIND_UNSUPPORTED', asset)
      }
      const stored = await this.client.v2MediaArtifact.findFirst({
        where: { id: asset.artifactId, workspaceId: this.workspaceId },
      })
      if (!stored) throw materializationFailure('ASSET_NOT_FOUND', asset)
      if (stored.status !== 'available') {
        throw materializationFailure('ASSET_UNAVAILABLE', asset)
      }
      if (
        stored.artifactKey !== asset.artifactKey ||
        stored.sha256 !== asset.sha256 ||
        stored.byteSize !== BigInt(asset.byteSize) ||
        stored.mediaType !== asset.kind
      ) {
        throw materializationFailure('ASSET_IDENTITY_MISMATCH', asset)
      }

      let storageRoot: string
      try {
        storageRoot = await realpath(this.root)
      } catch {
        throw materializationFailure('STORAGE_ROOT_UNAVAILABLE', asset)
      }
      const candidate = resolve(storageRoot, ...asset.artifactKey.split('/'))
      let canonicalPath: string
      try {
        canonicalPath = await realpath(candidate)
      } catch {
        throw materializationFailure('ASSET_BYTES_NOT_FOUND', asset)
      }
      if (!isContained(storageRoot, canonicalPath)) {
        throw materializationFailure('ASSET_PATH_OUTSIDE_STORAGE_ROOT', asset)
      }

      const before = await stat(canonicalPath)
      if (!before.isFile() || before.size !== asset.byteSize) {
        throw materializationFailure('ASSET_BYTE_SIZE_MISMATCH', asset)
      }
      const hash = createHash('sha256')
      let byteSize = 0
      for await (const chunk of createReadStream(canonicalPath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        byteSize += bytes.byteLength
        hash.update(bytes)
      }
      const after = await stat(canonicalPath)
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        throw materializationFailure('ASSET_CHANGED_DURING_READ', asset)
      }
      const sha256 = hash.digest('hex')
      if (byteSize !== asset.byteSize || sha256 !== asset.sha256) {
        throw materializationFailure('ASSET_CONTENT_MISMATCH', asset)
      }
      return {
        uri: pathToFileURL(canonicalPath).href,
        sha256,
        byteSize,
      }
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw materializationFailure('STORAGE_READ_FAILED', asset)
    }
  }
}
