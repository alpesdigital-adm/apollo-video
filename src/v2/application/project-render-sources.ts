import { assertDomain } from '../domain/errors.ts'
import type {
  ProjectProxyRenderSource,
  ProjectRenderSourceAsset,
} from './ports/project-proxy-render-repository.ts'
import type { RenderColorPipelineBinding } from './resolve-render-color-pipelines.ts'
import { calculateVersionHash } from './version-hash.ts'

export function projectRenderSourcesFingerprint(
  sources: readonly Readonly<ProjectRenderSourceAsset>[],
): string {
  assertDomain(
    sources.length >= 1 &&
      sources.length <= 128 &&
      new Set(sources.map((source) => source.artifactId)).size === sources.length &&
      sources.every((source) =>
        /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(source.artifactId) &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(source.manifestId) &&
        /^[a-f0-9]{64}$/.test(source.sha256) &&
        Number.isSafeInteger(source.byteSize) &&
        source.byteSize > 0 &&
        ['video', 'audio'].includes(source.mediaType) &&
        ['source-master', 'selected-insert'].includes(source.role)),
    'INVALID_RENDER_INPUT',
    'Project render source bundle is invalid',
  )
  return calculateVersionHash(
    [...sources]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
      .map((source) => ({
        artifactId: source.artifactId,
        manifestId: source.manifestId,
        artifactKey: source.artifactKey,
        sha256: source.sha256,
        byteSize: source.byteSize,
        mediaType: source.mediaType,
        container: source.container,
        role: source.role,
      })),
  )
}

export function projectProxyRenderInputHash(input: {
  source: Readonly<ProjectProxyRenderSource>
  colorPipelineBindings: readonly Readonly<RenderColorPipelineBinding>[]
}): string {
  const source = input.source
  const base = {
    projectId: source.projectId,
    projectVersionId: source.projectVersionId,
    editPlanSnapshotId: source.editPlanSnapshotId,
    editPlanHash: source.editPlanHash,
    sourceArtifactId: source.sourceArtifactId,
    sourceManifestId: source.sourceManifestId,
    sourceSha256: source.sourceSha256,
    renderSourcesFingerprint: projectRenderSourcesFingerprint(source.renderSources),
    colorPipelineBindings: input.colorPipelineBindings,
    format: source.format,
  }
  return calculateVersionHash(source.rangeReuse
    ? {
        kind: 'project-proxy-render/v2',
        ...base,
        rangeReuse: source.rangeReuse,
      }
    : { kind: 'project-proxy-render/v1', ...base })
}
