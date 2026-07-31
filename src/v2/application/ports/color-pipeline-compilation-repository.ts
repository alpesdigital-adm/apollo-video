import type {
  ColorMetadata,
  ColorTransform,
  MediaColorProbe,
} from '../../domain/color-and-export.ts'
import type {
  ColorPipelineCompilation,
} from '../../domain/color-pipeline-compilation.ts'

export interface PersistedColorPipelineCompilation {
  compilation: Readonly<ColorPipelineCompilation>
  requestFingerprint: string
  idempotencyKey: string
}

export interface ColorPipelineCompilationRepository {
  loadTrustedProbe(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<Readonly<MediaColorProbe> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    createdByClientId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedColorPipelineCompilation> | null>
  persist(value: Readonly<PersistedColorPipelineCompilation>): Promise<Readonly<{
    value: Readonly<PersistedColorPipelineCompilation>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    compilationId: string
  }): Promise<Readonly<PersistedColorPipelineCompilation> | null>
  listForSource(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<readonly Readonly<PersistedColorPipelineCompilation>[]>
}

export interface CreateColorPipelineCompilationInput {
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceManifestId: string
  outputMetadata: Readonly<ColorMetadata>
  stages: readonly Readonly<Omit<ColorTransform, 'input'>>[]
  actor: Readonly<{ type: 'api-client'; id: string }>
  idempotencyKey: string
}
