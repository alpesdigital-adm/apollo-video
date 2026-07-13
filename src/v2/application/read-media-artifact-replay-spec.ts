import { DomainError } from '../domain/errors.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'

export function readMediaArtifactReplaySpecService(dependencies: {
  repository: MediaArtifactQueryRepository
}) {
  return async function readMediaArtifactReplaySpec(
    workspaceId: string,
    artifactId: string,
    manifestId: string,
  ) {
    const normalizedArtifactId = artifactId.trim()
    const normalizedManifestId = manifestId.trim()
    if (normalizedArtifactId.length < 3 || normalizedArtifactId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'artifactId must contain 3 to 128 characters')
    }
    if (normalizedManifestId.length < 3 || normalizedManifestId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'manifestId must contain 3 to 128 characters')
    }

    const artifact = await dependencies.repository.findById(
      workspaceId,
      normalizedArtifactId,
    )
    if (!artifact) {
      throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
    }
    const manifest = artifact.manifests.find((item) => item.id === normalizedManifestId)
    if (!manifest) {
      throw new DomainError(
        'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND',
        'Media artifact manifest was not found',
      )
    }

    const available = Boolean(
      manifest.recipe.parametersRef &&
        manifest.recipeParameters &&
        manifest.recipe.parametersRef === manifest.recipeParameters.ref &&
        manifest.recipe.parametersHash === manifest.recipeParameters.parametersHash,
    )

    return {
      artifactId: artifact.id,
      manifestId: manifest.id,
      schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      recipe: {
        id: manifest.recipe.id,
        version: manifest.recipe.version,
        parametersHash: manifest.recipe.parametersHash,
      },
      available,
      ...(available && manifest.recipeParameters
        ? {
            parameters: {
              ref: manifest.recipeParameters.ref,
              canonicalByteSize: manifest.recipeParameters.canonicalByteSize,
              protection: { algorithm: manifest.recipeParameters.algorithm },
            },
          }
        : {}),
      issues: available
        ? []
        : [
            {
              code: 'REPLAY_PARAMETERS_MISSING' as const,
              message: 'Manifest predates protected replay parameters',
            },
          ],
    }
  }
}
