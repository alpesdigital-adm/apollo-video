import { DomainError } from '../domain/errors.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'

export interface ReadMediaArtifactDependencies {
  repository: MediaArtifactQueryRepository
}

export function readMediaArtifactService(dependencies: ReadMediaArtifactDependencies) {
  return async function readMediaArtifact(workspaceId: string, artifactId: string) {
    const normalizedId = artifactId.trim()
    if (normalizedId.length < 3 || normalizedId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'artifactId must contain 3 to 128 characters')
    }

    const artifact = await dependencies.repository.findById(workspaceId, normalizedId)
    if (!artifact) {
      throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
    }
    return artifact
  }
}
