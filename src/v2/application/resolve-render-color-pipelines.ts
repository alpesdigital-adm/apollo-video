import type { ColorPipelineCompilation } from '../domain/color-pipeline-compilation.ts'
import { DomainError } from '../domain/errors.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import type { ProjectRenderSourceAsset } from './ports/project-proxy-render-repository.ts'

export interface RenderColorPipelineBinding {
  sourceArtifactId: string
  sourceManifestId: string
  compilationId: string
  compilationHash: string
  pipelineHash: string
}

export async function resolveRenderColorPipelineBindings(input: {
  repository: ColorPipelineCompilationRepository
  workspaceId: string
  projectId: string
  sources: readonly Readonly<ProjectRenderSourceAsset>[]
}): Promise<readonly Readonly<RenderColorPipelineBinding>[]> {
  const videos = input.sources.filter((source) => source.mediaType === 'video')
  const bindings = await Promise.all(videos.map(async (source) => {
    const candidates = await input.repository.listForSource({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sourceArtifactId: source.artifactId,
      sourceManifestId: source.manifestId,
    })
    if (candidates.length !== 1) {
      throw new DomainError(
        'INVALID_RENDER_INPUT',
        candidates.length === 0
          ? 'Every video render source requires an exact color pipeline compilation'
          : 'Video render source has ambiguous color pipeline compilations',
        { sourceArtifactId: source.artifactId, sourceManifestId: source.manifestId },
      )
    }
    const compilation = candidates[0]!.compilation
    return Object.freeze({
      sourceArtifactId: compilation.sourceArtifactId,
      sourceManifestId: compilation.sourceManifestId,
      compilationId: compilation.id,
      compilationHash: compilation.compilationHash,
      pipelineHash: compilation.pipeline.pipelineHash,
    })
  }))
  return Object.freeze(bindings.sort((left, right) =>
    left.sourceArtifactId.localeCompare(right.sourceArtifactId)))
}

export async function loadBoundRenderColorPipelines(input: {
  repository: ColorPipelineCompilationRepository
  workspaceId: string
  projectId: string
  bindings: readonly Readonly<RenderColorPipelineBinding>[]
}): Promise<ReadonlyMap<string, Readonly<ColorPipelineCompilation>>> {
  const entries = await Promise.all(input.bindings.map(async (binding) => {
    const stored = await input.repository.read({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      compilationId: binding.compilationId,
    })
    const value = stored?.compilation
    if (!value || value.sourceArtifactId !== binding.sourceArtifactId ||
      value.sourceManifestId !== binding.sourceManifestId ||
      value.compilationHash !== binding.compilationHash ||
      value.pipeline.pipelineHash !== binding.pipelineHash) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Bound color pipeline compilation changed or disappeared')
    }
    return [binding.sourceArtifactId, value] as const
  }))
  if (new Set(entries.map(([artifactId]) => artifactId)).size !== entries.length) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline bindings contain duplicate sources')
  }
  return new Map(entries)
}
