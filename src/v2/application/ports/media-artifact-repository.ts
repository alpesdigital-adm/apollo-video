import type { MediaArtifactManifest } from '../../domain/media-artifact.ts'

export interface MediaArtifactPersistenceBundle {
  workspaceId: string
  artifactId: string
  manifestId: string
  lineageIds: readonly string[]
  manifest: MediaArtifactManifest
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
