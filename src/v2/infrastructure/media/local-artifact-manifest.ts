import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { stableSerialize } from '../../domain/canonical-hash.ts'
import {
  assertMediaArtifactManifest,
  createMediaArtifactManifest,
  type CreateMediaArtifactManifestInput,
  type MediaArtifactManifest,
  type MediaArtifactManifestV1,
} from '../../domain/media-artifact.ts'
import { DomainError } from '../../domain/errors.ts'

export type LocalMediaArtifactManifestInput = Omit<
  CreateMediaArtifactManifestInput,
  'artifactSha256' | 'byteSize'
> & {
  filePath: string
}

export async function calculateFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function inspectLocalMediaArtifact(
  input: LocalMediaArtifactManifestInput,
): Promise<MediaArtifactManifestV1> {
  const metadata = await stat(input.filePath)
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new DomainError(
      'INVALID_MEDIA_ARTIFACT',
      'Local media artifact must be a non-empty file',
    )
  }

  return createMediaArtifactManifest({
    artifactKey: input.artifactKey,
    artifactSha256: await calculateFileSha256(input.filePath),
    byteSize: metadata.size,
    mediaType: input.mediaType,
    container: input.container,
    recipe: input.recipe,
    sources: input.sources,
    probe: input.probe,
  })
}

function stagedManifestPath(manifestPath: string): string {
  const parsed = path.parse(manifestPath)
  return path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.partial${parsed.ext}`)
}

export async function writeLocalMediaArtifactManifest(
  manifestPath: string,
  manifest: MediaArtifactManifest,
): Promise<void> {
  assertMediaArtifactManifest(manifest)
  const stagedPath = stagedManifestPath(manifestPath)
  try {
    await writeFile(stagedPath, `${stableSerialize(manifest)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    await rename(stagedPath, manifestPath)
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => undefined)
    throw error
  }
}
