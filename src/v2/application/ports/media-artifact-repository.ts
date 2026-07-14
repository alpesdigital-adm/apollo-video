import type { MediaArtifactManifest } from '../../domain/media-artifact.ts'
import type { RecipeParameterPayload } from '../../domain/recipe-parameters.ts'
import type { RenderInputPayload } from '../../domain/render-input-payload.ts'

export interface MediaArtifactPersistenceBundle {
  workspaceId: string
  artifactId: string
  manifestId: string
  lineageIds: readonly string[]
  manifest: MediaArtifactManifest
  recipeParameters?: RecipeParameterPayload
  renderInput?: RenderInputPayload
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
