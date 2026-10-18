import { assertDomain } from '../domain/errors.ts'
import { ASS_EMISSION_POLICY } from '../domain/ass-emission-policy.ts'
import type {
  ProjectProxyRenderSource,
  ProjectRenderSourceAsset,
} from './ports/project-proxy-render-repository.ts'
import type { RenderColorPipelineBinding } from './resolve-render-color-pipelines.ts'
import { calculateVersionHash } from './version-hash.ts'

const SEAL_HASH_PATTERN = /^[a-f0-9]{64}$/

/**
 * The State variant an operation's context names, once a later step persists it there; none today (the State's only output). The
 * workers read through it so that step does not touch them again.
 */
export function contextVariantSelection(context: object): Readonly<{ variantId?: string }> {
  const value = (context as { variantId?: unknown }).variantId
  return typeof value === 'string' && value.length > 0 ? { variantId: value } : {}
}

/** The consumption seal a render input hash is built over. A source without it was not read through the consumption verdict. */
function requireConsumptionSealHash(value: unknown): string {
  assertDomain(typeof value === 'string' && SEAL_HASH_PATTERN.test(value), 'INVALID_RENDER_INPUT',
    'Render input is not sealed to an output consumption verdict')
  return value as string
}

/** Enqueue and worker share the exact pre-render identity. The policy is input,
 * never an output receipt hash: no MP4 -> receipt -> input hash cycle.
 * `outputConsumptionSealHash` seals the exact Version, State, variant revision and materialization the final export consumes
 * (the persisted `final` verdict): another State, revision or materialization is another input. */
export function projectFinalRenderInputHash(input: Readonly<Record<string, unknown>>): string {
  requireConsumptionSealHash(input.outputConsumptionSealHash)
  return calculateVersionHash({ ...input, kind: 'project-final-export/v2', assEmissionPolicy: ASS_EMISSION_POLICY })
}

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
        ['source-master', 'selected-insert', 'approved-music'].includes(source.role)),
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
    assEmissionPolicy: ASS_EMISSION_POLICY,
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
    // The persisted consumption verdict this source was read through: Version, State, variant revision and materialization.
    outputConsumptionSealHash: requireConsumptionSealHash(source.outputConsumption?.sealHash),
  }
  return calculateVersionHash(source.unchangedReuse
    ? {
        kind: 'project-proxy-render/v6',
        ...base,
        unchangedReuse: source.unchangedReuse,
      }
    : source.rangeReuse ? {
        kind: 'project-proxy-render/v5',
        ...base,
        rangeReuse: source.rangeReuse,
      }
    : { kind: 'project-proxy-render/v4', ...base })
}
