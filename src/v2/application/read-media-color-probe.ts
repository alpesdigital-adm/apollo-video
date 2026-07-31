import { DomainError } from '../domain/errors.ts'
import type {
  MediaArtifactQueryRepository,
} from './ports/media-artifact-query-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export function readMediaColorProbeService(dependencies: {
  repository: MediaArtifactQueryRepository
}) {
  return async function read(workspaceId: string, artifactId: string) {
    const normalizedWorkspaceId = workspaceId.trim()
    const normalizedArtifactId = artifactId.trim()
    if (
      !ID.test(normalizedWorkspaceId) ||
      !ID.test(normalizedArtifactId)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Color probe scope is invalid',
      )
    }
    const artifact = await dependencies.repository.findById(
      normalizedWorkspaceId,
      normalizedArtifactId,
    )
    if (!artifact) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        'Media artifact was not found',
      )
    }
    const probe = await dependencies.repository.findColorProbe(
      normalizedWorkspaceId,
      normalizedArtifactId,
    )
    if (!probe) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        'Media color probe was not found',
      )
    }
    return probe
  }
}
