import { assertDomain } from '../domain/errors.ts'
import { REFRAME_COMPOSITION_ID } from '../domain/render-reframe-plan.ts'
import { ASS_EMISSION_POLICY } from '../domain/ass-emission-policy.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } from './ports/editorial-proxy-renderer.ts'
import { FINAL_CAPTION_CERTIFICATION_POLICY_SHA256 } from '../domain/final-caption-certification.ts'
import type {
  ProjectProxyRenderSource,
  ProjectRenderSourceAsset,
} from './ports/project-proxy-render-repository.ts'
import type { RenderColorPipelineBinding } from './resolve-render-color-pipelines.ts'
import { calculateVersionHash } from './version-hash.ts'

const SEAL_HASH_PATTERN = /^[a-f0-9]{64}$/

/**
 * The State variant an operation's context names (`outputVariantId`, written at enqueue from the sealed consumption). A context
 * without it is a legacy row, written before the column existed: it is read with the sole-output rule only (a State with several
 * outputs is then refused, never guessed). The workers read through it, so the output a render was made for is never re-chosen.
 */
export function contextVariantSelection(context: object): Readonly<{ variantId?: string }> {
  const value = (context as { outputVariantId?: unknown }).outputVariantId
  return typeof value === 'string' && value.length > 0 ? { variantId: value } : {}
}

/**
 * The stable State variant a source was read for (the consumption it was sealed to). A consumer attributes what it persists
 * (the operation context, the completion of a render) to this, never to an aspect ratio.
 */
export function sourceOutputVariantId(source: Readonly<Pick<ProjectProxyRenderSource, 'outputConsumption'>>): string {
  const variantId = source.outputConsumption?.seal?.variantId
  assertDomain(typeof variantId === 'string' && variantId.length > 0, 'INVALID_RENDER_INPUT', 'Render input is not sealed to an output variant')
  return variantId
}

/** The consumption seal a render input hash is built over. A source without it was not read through the consumption verdict. */
function requireConsumptionSealHash(value: unknown): string {
  assertDomain(typeof value === 'string' && SEAL_HASH_PATTERN.test(value), 'INVALID_RENDER_INPUT',
    'Render input is not sealed to an output consumption verdict')
  return value as string
}

/** Enqueue and worker share the exact pre-render identity. The policies are input,
 * never an output receipt hash: no MP4 -> receipt -> input hash cycle.
 * `outputConsumptionSealHash` seals the exact Version, State, variant revision and materialization the final export consumes
 * (the persisted `final` verdict): another State, revision or materialization is another input.
 * The final-caption certification policy (W65b) is pinned here by its digest: an operation queued under another policy fails the
 * worker's recomputation instead of being certified under rules nobody approved it with. */
export function projectFinalRenderInputHash(input: Readonly<Record<string, unknown>>): string {
  requireConsumptionSealHash(input.outputConsumptionSealHash)
  return calculateVersionHash({
    ...input, kind: 'project-final-export/v2', assEmissionPolicy: ASS_EMISSION_POLICY,
    // W66r. A render made from a persisted reframe plan names the geometry that laid its crop on the canvas; one made without a plan does not.
    ...(typeof input.reframeRecordHash === 'string' ? { reframeComposition: REFRAME_COMPOSITION_ID } : {}),
    captionCertificationPolicySha256: FINAL_CAPTION_CERTIFICATION_POLICY_SHA256,
  })
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
    // W66r. The persisted reframe plan changes the pixels, so another plan is another input. Absent when none was persisted, which keeps the
    // identity of every render made before plans existed.
    ...(source.reframeRecordHash ? { reframeRecordHash: source.reframeRecordHash, reframeComposition: REFRAME_COMPOSITION_ID } : {}),
    // W68. The per-segment subtitle exceptions that carry a value change the pixels, so another set is another input. Absent when the
    // output has none (or every one was reset), which keeps the identity of every render made before they existed.
    ...(source.subtitleOverridesHash ? { subtitleOverridesHash: source.subtitleOverridesHash } : {}),
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

/**
 * W70 prep. The Version-INDEPENDENT content address of the pre-render identity of one output's proxy: what `projectProxyRenderInputHash` says
 * about the pixels, less everything that merely names the Version it was read at (the Version id and hash, the EditPlan snapshot id, the State and
 * materialization of the consumption seal, the identity fields of the EditPlan itself). Two Versions of a project in which an output is drawn from
 * the same inputs have the same address; any input that moves - the plan content, a source, the colour bindings, the output spec revision, the
 * reframe record, the subtitle exceptions, the subtitle preset, the OCR evidence the placement reads, a placement asset, the renderer or the
 * recipe - gives another one. A render is carried from one Version to another only on an exact match.
 *
 * What it cannot see, because the render input hash cannot either: face evidence published AFTER the earlier render (the placement plan reads
 * the sealed face windows at render time). Carrying keeps the pixels and the verdict the output had; it does not re-run perception.
 */
export function projectProxyRenderContentHash(input: {
  source: Readonly<ProjectProxyRenderSource>
  colorPipelineBindings: readonly Readonly<RenderColorPipelineBinding>[]
}): string {
  const source = input.source
  const seal = source.outputConsumption?.seal
  assertDomain(seal !== undefined && SEAL_HASH_PATTERN.test(source.outputConsumption.sealHash), 'INVALID_RENDER_INPUT', 'Render input is not sealed to an output consumption verdict')
  const { id: _id, projectVersionId: _projectVersionId, createdAt: _createdAt, ...planContent } = source.editPlan as unknown as Record<string, unknown>
  const resolution = source.subtitleResolution
  return calculateVersionHash({
    kind: 'project-proxy-render-content/v1',
    renderer: FFMPEG_EDITORIAL_RENDERER_VERSION,
    recipe: EDITORIAL_PROXY_RECIPE_VERSION,
    assEmissionPolicy: ASS_EMISSION_POLICY,
    projectId: source.projectId,
    format: source.format,
    editPlanContentHash: calculateCanonicalHash(planContent),
    sourceArtifactId: source.sourceArtifactId,
    sourceManifestId: source.sourceManifestId,
    sourceSha256: source.sourceSha256,
    renderSourcesFingerprint: projectRenderSourcesFingerprint(source.renderSources),
    colorPipelineBindings: input.colorPipelineBindings,
    output: { variantId: seal.variantId, outputSpecRevisionId: seal.outputSpecRevisionId, specHash: seal.specHash },
    subtitleResolution: resolution ? {
      enabled: resolution.enabled, presetId: resolution.presetId, presetHash: resolution.presetHash, registryHash: resolution.registryHash,
      presetSnapshotHash: resolution.presetSnapshot?.snapshotHash ?? null,
    } : null,
    trustedOcr: source.trustedOcr ? { envelopeHash: source.trustedOcr.envelopeHash, timeMapHash: source.trustedOcr.timeMapHash } : null,
    formatSubjects: source.formatSubjects ? calculateCanonicalHash(source.formatSubjects) : null,
    placementAssets: source.placementAssets ? source.placementAssets.map((asset) => asset.sha256).toSorted() : null,
    reframeRecordHash: source.reframeRecordHash ?? null,
    subtitleOverridesHash: source.subtitleOverridesHash ?? null,
  })
}
