import { DomainError } from '../domain/errors.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'

export function readMediaArtifactProvenanceService(dependencies: {
  repository: MediaArtifactQueryRepository
}) {
  return async function readMediaArtifactProvenance(
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

    const issues = manifest.sources
      .filter((source) => !source.execution)
      .map((source) => ({
        code: 'EXECUTION_PROVENANCE_MISSING' as const,
        sourceArtifactId: source.artifactId,
        ordinal: source.ordinal,
        message: 'Lineage edge has no versioned execution provenance',
      }))

    return {
      artifactId: artifact.id,
      manifestId: manifest.id,
      schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      complete: issues.length === 0,
      edges: manifest.sources.map((source) => ({
        sourceArtifactId: source.artifactId,
        role: source.role,
        ordinal: source.ordinal,
        ...(source.execution
          ? {
              execution: {
                tool: { ...source.execution.tool },
                ...(source.execution.model
                  ? { model: { ...source.execution.model } }
                  : {}),
              },
            }
          : {}),
      })),
      issues,
    }
  }
}
