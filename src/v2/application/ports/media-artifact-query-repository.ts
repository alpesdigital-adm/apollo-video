import type {
  MediaArtifactExecutionProvenance,
  MediaArtifactProbe,
  MediaArtifactType,
  MediaArtifactLifecycleStatus,
} from '../../domain/media-artifact.ts'
import type { MediaColorProbe } from '../../domain/color-and-export.ts'

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
    parametersRef?: string
  }
  recipeParameters?: {
    ref: string
    parametersHash: string
    canonicalByteSize: number
    algorithm: 'aes-256-gcm'
  }
  renderInput?: {
    ref: string
    inputHash: string
    canonicalByteSize: number
    algorithm: 'aes-256-gcm'
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
  status: MediaArtifactLifecycleStatus
  lifecycleRevision: number
  manifests: readonly MediaArtifactManifestRecord[]
  createdAt: string
}

export interface MediaArtifactQueryRepository {
  findById(workspaceId: string, artifactId: string): Promise<MediaArtifactRecord | null>
  findColorProbe(
    workspaceId: string,
    artifactId: string,
  ): Promise<Readonly<MediaColorProbe> | null>
}
