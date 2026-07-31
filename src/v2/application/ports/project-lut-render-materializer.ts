import type { ColorPipelineCompilation } from '../../domain/color-pipeline-compilation.ts'

export interface MaterializedProjectLut {
  selectionId: string
  selectionHash: string
  materializedCubeHash?: string
  asset?: Readonly<{ artifactId: string; artifactKey: string; sha256: string; byteSize: number }>
  lutPaths: Readonly<Record<string, string>>
}

export interface ProjectLutRenderMaterializer {
  materialize(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    operationId: string
    compilations: readonly Readonly<ColorPipelineCompilation>[]
  }): Promise<Readonly<MaterializedProjectLut>>
  cleanup(operationId: string): Promise<void>
}
