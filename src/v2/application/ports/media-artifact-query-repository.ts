import type {
  MediaArtifactExecutionProvenance,
  MediaArtifactProbe,
  MediaArtifactType,
} from '../../domain/media-artifact.ts'

export interface MediaArtifactLineageRecord {
  artifactId: string
  artifactKey: string
  sha256: string
  role: string
  ordinal: number
  execution?: MediaArtifactExecutionProvenance
}

export interface MediaArtifactManifestRecord {
  id: string
  schemaVersion: string
  manifestHash: string
  recipe: {
    id: string
    version: string
    parametersHash: string
  }
  probe?: MediaArtifactProbe
  sources: readonly MediaArtifactLineageRecord[]
  createdAt: string
}

export interface MediaArtifactRecord {
  id: string
  workspaceId: string
  artifactKey: string
  sha256: string
  byteSize: bigint
  mediaType: MediaArtifactType
  container: string
  status: 'available' | 'quarantined' | 'deleted'
  manifests: readonly MediaArtifactManifestRecord[]
  createdAt: string
}

export interface MediaArtifactQueryRepository {
  findById(workspaceId: string, artifactId: string): Promise<MediaArtifactRecord | null>
}
