import { assertDomain } from '../domain/errors.ts'
import { REFRAME_COMPOSITION_ID } from '../domain/render-reframe-plan.ts'
import { ASS_EMISSION_POLICY } from '../domain/ass-emission-policy.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } from './ports/editorial-proxy-renderer.ts'
import { FINAL_CAPTION_ANCHOR_POLICY, FINAL_CAPTION_CERTIFICATION_POLICY_SHA256 } from '../domain/final-caption-certification.ts'
import { CAPTION_BAND_TOLERANCE_PX, CAPTION_PIXEL_CODES } from '../domain/caption-pixel-verdict.ts'
import { CAPTION_TEXT_LAYOUT_ID } from '../domain/caption-text-layout.ts'
import { COLOR_CRITIC_REPORT_SCHEMA_VERSION, DEFAULT_COLOR_CRITIC_POLICY } from '../domain/color-critic-report.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from '../domain/face-evidence-policy.ts'
import { FORMAT_QUALITY_CODES, FORMAT_QUALITY_POLICY, FORMAT_QUALITY_REPORT_SCHEMA_VERSION } from '../domain/format-quality-critic.ts'
import { OUTPUT_FORMAT_REGISTRY } from '../domain/output-format-registry.ts'
import { PROXY_OUTPUT_SPECS, PROXY_REVIEW_POLICY, PROXY_REVIEW_SCHEMA_VERSION } from './render-workflow.ts'
import { MP4_PIXEL_CRITIC_POLICY_SHA256 } from '../domain/mp4-pixel-quality.ts'
import { renderColorGradeContent } from '../domain/render-color-grade.ts'
import { DEFAULT_SUBTITLE_ANCHOR_POLICY } from '../domain/subtitle-anchor-plan.ts'
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
    // W70 readiness (R2). The colour grade the render applies (effective ColorPlan and LUT selection, by ancestry). Absent on a source the
    // project render repository did not read (a renderable snapshot), which keeps its identity.
    ...(source.colorGrade ? { colorGrade: source.colorGrade } : {}),
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
 * What it cannot see, because it is read only when the render runs: the face windows the placement reads and the Director issues the review
 * is built over. A render stores their digests at completion and a carry compares them (`proxy-render-evidence.ts`). v2 (W70 readiness) adds
 * the colour grade (effective ColorPlan and LUT selection) and the review policies.
 */
export function projectProxyRenderContentHash(input: {
  source: Readonly<ProjectProxyRenderSource>
  colorPipelineBindings: readonly Readonly<RenderColorPipelineBinding>[]
  /** The digest of the review policies the render is judged under; defaults to the live ones (a test passes another to prove it moves the address). */
  reviewPolicySha256?: string
}): string {
  const source = input.source
  const seal = source.outputConsumption?.seal
  assertDomain(seal !== undefined && SEAL_HASH_PATTERN.test(source.outputConsumption.sealHash), 'INVALID_RENDER_INPUT', 'Render input is not sealed to an output consumption verdict')
  const { id: _id, projectVersionId: _projectVersionId, createdAt: _createdAt, ...planContent } = source.editPlan as unknown as Record<string, unknown>
  const resolution = source.subtitleResolution
  return calculateVersionHash({
    kind: 'project-proxy-render-content/v2',
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
    // W70 readiness (R2, Opus validation). What the colour grade does to the pixels (not the rows holding it), and the policies the review of
    // a render is judged under: another grade, or another critic, is another content.
    colorGrade: source.colorGrade ? renderColorGradeContent(source.colorGrade) : null,
    reviewPolicySha256: input.reviewPolicySha256 ?? PROXY_REVIEW_POLICY_SHA256,
  })
}

/** The policy objects a proxy's review is judged under; every field is the live object or constant the evaluation reads. */
export interface ProxyReviewPolicyParts {
  proxyReviewSchemaVersion: string
  proxyReviewPolicy: unknown
  proxyOutputSpecs: unknown
  outputFormatRegistryHash: string
  formatQualityReportSchemaVersion: string
  formatQualityPolicy: unknown
  formatQualityCodes: unknown
  captionPixelCodes: unknown
  captionBandTolerancePx: number
  captionTextLayoutId: string
  mp4PixelCriticPolicySha256: string
  faceEvidencePolicySha256: string
  colorCriticReportSchemaVersion: string
  colorCriticPolicy: unknown
  subtitleAnchorPolicy: unknown
  finalCaptionAnchorPolicy: unknown
}

/** The live policies. */
export const PROXY_REVIEW_POLICY_PARTS: Readonly<ProxyReviewPolicyParts> = Object.freeze({
  proxyReviewSchemaVersion: PROXY_REVIEW_SCHEMA_VERSION,
  proxyReviewPolicy: PROXY_REVIEW_POLICY,
  proxyOutputSpecs: PROXY_OUTPUT_SPECS,
  outputFormatRegistryHash: OUTPUT_FORMAT_REGISTRY.registryHash,
  formatQualityReportSchemaVersion: FORMAT_QUALITY_REPORT_SCHEMA_VERSION,
  formatQualityPolicy: FORMAT_QUALITY_POLICY,
  formatQualityCodes: FORMAT_QUALITY_CODES,
  captionPixelCodes: CAPTION_PIXEL_CODES,
  captionBandTolerancePx: CAPTION_BAND_TOLERANCE_PX,
  captionTextLayoutId: CAPTION_TEXT_LAYOUT_ID,
  mp4PixelCriticPolicySha256: MP4_PIXEL_CRITIC_POLICY_SHA256,
  faceEvidencePolicySha256: FACE_EVIDENCE_POLICY_SHA256,
  colorCriticReportSchemaVersion: COLOR_CRITIC_REPORT_SCHEMA_VERSION,
  colorCriticPolicy: DEFAULT_COLOR_CRITIC_POLICY,
  subtitleAnchorPolicy: DEFAULT_SUBTITLE_ANCHOR_POLICY,
  finalCaptionAnchorPolicy: FINAL_CAPTION_ANCHOR_POLICY,
})

/**
 * W70 readiness (R2). The policies a proxy's review is judged under, pinned by content and DERIVED from the objects and constants the
 * evaluation reads (never retyped literals): the review and report schema versions, the review's duration tolerance and output specs, the format
 * critic's density policy, codes and the registry its safe areas come from, the caption pixel critic's codes and tolerance, the caption layout,
 * the MP4 critic's policy, the face evidence policy, the colour critic's policy and the anchor policies. A carry keeps the verdict the earlier
 * render had, so a change of any of them must make another content address, never carry an old verdict.
 */
export function buildProxyReviewPolicyIdentity(parts: Readonly<ProxyReviewPolicyParts> = PROXY_REVIEW_POLICY_PARTS) {
  return Object.freeze({
    proxyReview: Object.freeze({ schemaVersion: parts.proxyReviewSchemaVersion, policy: calculateCanonicalHash(parts.proxyReviewPolicy), outputSpecs: calculateCanonicalHash(parts.proxyOutputSpecs) }),
    outputFormatRegistryHash: parts.outputFormatRegistryHash,
    formatQuality: Object.freeze({
      schemaVersion: parts.formatQualityReportSchemaVersion,
      policy: calculateCanonicalHash(parts.formatQualityPolicy),
      codes: calculateCanonicalHash(parts.formatQualityCodes),
    }),
    captionPixel: Object.freeze({ codes: calculateCanonicalHash(parts.captionPixelCodes), bandTolerancePx: parts.captionBandTolerancePx }),
    captionTextLayout: parts.captionTextLayoutId,
    mp4PixelCriticPolicySha256: parts.mp4PixelCriticPolicySha256,
    faceEvidencePolicySha256: parts.faceEvidencePolicySha256,
    colorCritic: Object.freeze({ report: parts.colorCriticReportSchemaVersion, policy: calculateCanonicalHash(parts.colorCriticPolicy) }),
    anchorPolicies: Object.freeze({ subtitle: calculateCanonicalHash(parts.subtitleAnchorPolicy), finalCaption: calculateCanonicalHash(parts.finalCaptionAnchorPolicy) }),
  })
}

export const PROXY_REVIEW_POLICY_IDENTITY = buildProxyReviewPolicyIdentity()
export function calculateProxyReviewPolicySha256(parts: Readonly<ProxyReviewPolicyParts> = PROXY_REVIEW_POLICY_PARTS): string {
  return calculateCanonicalHash(buildProxyReviewPolicyIdentity(parts))
}
export const PROXY_REVIEW_POLICY_SHA256: string = calculateProxyReviewPolicySha256()

