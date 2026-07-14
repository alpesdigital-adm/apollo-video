import { DomainError } from '../domain/errors.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'

export function readMediaArtifactRenderInputService(dependencies: {
  repository: MediaArtifactQueryRepository
}) {
  return async function readMediaArtifactRenderInput(
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

    const available = Boolean(manifest.renderInput)
    return {
      artifactId: artifact.id,
      manifestId: manifest.id,
      schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      available,
      ...(manifest.renderInput
        ? {
            renderInput: {
              ref: manifest.renderInput.ref,
              inputHash: manifest.renderInput.inputHash,
              canonicalByteSize: manifest.renderInput.canonicalByteSize,
              protection: { algorithm: manifest.renderInput.algorithm },
            },
          }
        : {}),
      issues: available
        ? []
        : [
            {
              code: 'RENDER_INPUT_MISSING' as const,
              message: 'Manifest predates protected RenderInput',
            },
          ],
    }
  }
}
