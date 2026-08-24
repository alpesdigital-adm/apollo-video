import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'
import type { resolveColorPlan } from '../../domain/color-and-export.ts'

export interface MaterializedProjectLutAsset {
  artifactId: string
  artifactKey: string
  parametersHash: string
  intensity: number
  cubeHash: string
  sha256: string
  byteSize: number
}

export interface MaterializedProjectLut {
  selectionId: string
  selectionHash: string
  materializedCubeHash?: string
  materializedCubeHashes?: readonly string[]
  asset?: Readonly<MaterializedProjectLutAsset>
  assets?: readonly Readonly<MaterializedProjectLutAsset>[]
  lutPaths: Readonly<Record<string, string>>
}

export interface ProjectLutRenderMaterializer {
  materialize(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    operationId: string
    compilations: readonly Readonly<ColorPipelineCompilation>[]
    executions?: readonly Readonly<ReturnType<typeof resolveColorPlan>>[]
  }): Promise<Readonly<MaterializedProjectLut>>
  cleanup(operationId: string): Promise<void>
}
