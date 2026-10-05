import { DomainError } from '../domain/errors.ts'
import type { MediaLibraryRepository } from './ports/media-library-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ArtifactContentStorage } from './ports/artifact-content-storage.ts'
import { readArtifactContentService } from './read-artifact-content.ts'

/** Authorize the original on every read: derivatives cannot bypass revoked rights. */
export function readMediaLibraryPreviewService(dependencies: {
  library: MediaLibraryRepository; artifacts: MediaArtifactQueryRepository; storage: ArtifactContentStorage; clock?: () => Date
}) {
  return async (input: { workspaceId: string; itemId: string; kind: 'thumbnail' | 'waveform' }) => {
    if (!['thumbnail', 'waveform'].includes(input.kind)) throw new DomainError('INVALID_ARGUMENT', 'Preview kind is invalid')
    const item = await dependencies.library.findById(input.workspaceId, input.itemId, dependencies.clock?.() ?? new Date())
    if (!item || item.status !== 'usable') throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Library preview was not found')
    if (item.rights.status !== 'eligible') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Current source rights prohibit this preview', { reasonCodes: item.rights.reasonCodes })
    const preview = item.preview[input.kind]
    if (preview.status !== 'available' || !preview.artifactId) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Library preview is unavailable')
    const [original, derived] = await Promise.all([
      dependencies.artifacts.findById(input.workspaceId, item.source.artifactId),
      dependencies.artifacts.findById(input.workspaceId, preview.artifactId),
    ])
    if (!original || original.status !== 'available' || !derived || derived.status !== 'available' || derived.mediaType !== 'image') throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Library preview content is unavailable')
    if (!derived.manifests.some((manifest) => manifest.sources.some((source) => source.artifactId === original.id && source.sha256 === original.sha256 && source.artifactKey === original.artifactKey))) throw new DomainError('PERSISTENCE_CONFLICT', 'Library preview has no verified original lineage')
    return readArtifactContentService({ artifacts: dependencies.artifacts, storage: dependencies.storage, library: dependencies.library, clock: dependencies.clock })({ workspaceId: input.workspaceId, artifactId: derived.id, rangeHeader: null })
  }
}
