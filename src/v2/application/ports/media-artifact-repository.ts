import type { MediaArtifactManifestV1 } from '../../domain/media-artifact.ts'

export interface MediaArtifactPersistenceBundle {
  workspaceId: string
  artifactId: string
  manifestId: string
  lineageIds: readonly string[]
  manifest: MediaArtifactManifestV1
  createdAt: string
}

export interface MediaArtifactPersistenceResult {
  artifactId: string
  manifestId: string
  replayed: boolean
}

export interface MediaArtifactPersistenceRepository {
  persistOrReplay(
    bundle: MediaArtifactPersistenceBundle,
  ): Promise<MediaArtifactPersistenceResult>
}
