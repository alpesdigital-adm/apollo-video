import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION,
  serializeOutputCanonicalJson, validateOutputCanonicalPolicy, type OutputCanonicalPolicy } from './output-canonical-policy.ts'
import { assertDomain } from './errors.ts'
import { createOutputSpec, type OutputSpec } from './output-spec.ts'

export type OutputJson = null | boolean | number | string | readonly OutputJson[] |
  { readonly [key: string]: OutputJson }
export interface OutputProvenance {
  kind: 'creation-command' | 'edit-command' | 'media-ingest-operation'
  id: string
  hash: string
}
export interface OutputVariant {
  id: string
  workspaceId: string
  projectId: string
  createdCommand: Readonly<OutputProvenance & { kind: 'creation-command' | 'edit-command' }>
  createdAt: string
}
export interface SealedOutputDocument {
  schemaVersion: string
  document: OutputJson
  hash: string
}

/** These are effective settings, never a request to consult a delivery registry.
 * Channel count is explicit: the current adapter does not select one, so its
 * cutover must honor this value before this profile can be used for rendering.
 * No factory fills any of these fields from current defaults. */
export interface MaterializedOutputEncoding {
  codec: 'h264'
  encoder: 'libx264'
  pixelFormat: 'yuv420p'
  container: 'mp4'
  faststart: true
  width: number
  height: number
  fps: number
  quality: Readonly<{ mode: 'crf'; value: number; preset: 'medium' | 'veryfast' }>
  audio: Readonly<{ codec: 'aac'; bitrateKbps: number; sampleRateHz: 48000; channels: number }>
}
export interface MaterializedDeliveryProfile {
  schemaVersion: 'materialized-delivery-profile/v1'
  id: string
  version: number
  rendererContractVersion: 'ffmpeg-editorial-output/v1'
  final: Readonly<MaterializedOutputEncoding>
  proxy: Readonly<MaterializedOutputEncoding>
  proxyToFinal: Readonly<{
    schemaVersion: 'output-canvas-transform/v1'
    scaleX: number
    scaleY: number
  }>
  subtitles: Readonly<{
    mode: 'none' | 'burn-in' | 'sidecar'
    configuration: Readonly<SealedOutputDocument> | null
    fontAssets: readonly Readonly<{ artifactId: string; sha256: string }>[]
  }>
}

/** specHash seals this complete document. Origin Command hash is stored beside
 * it, outside the payload: Command may include this document without a cycle. */
export interface OutputSpecRevisionBody extends OutputCanonicalPolicy {
  schemaVersion: 'output-spec-revision/v1'
  id: string
  variantId: string
  workspaceId: string
  projectId: string
  revisionNumber: number
  output: Readonly<OutputSpec>
  profile: Readonly<MaterializedDeliveryProfile>
  preset: Readonly<SealedOutputDocument> | null
  createdAt: string
}
export interface OutputSpecRevision {
  document: Readonly<OutputSpecRevisionBody>
  specHash: string
  createdCommand: Readonly<OutputProvenance & { kind: 'creation-command' | 'edit-command' }>
}

export function requireOutputId(value: unknown, field: string): asserts value is string {
  assertDomain(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value),
    'INVALID_OUTPUT_SPEC', `Invalid ${field}`)
}
export function requireOutputHash(value: unknown, field: string): asserts value is string {
  assertDomain(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    'INVALID_OUTPUT_SPEC', `Invalid ${field}`)
}
// Only copies produced below are admitted: Object.freeze supplied by a caller
// does not prove its descendants or JSON descriptors. Retaining these identities
// lets semantic validators recognize their own immutable constructor outputs.
const immutableOutputJson = new WeakSet<object>()
export function freezeOutputJson(value: OutputJson): OutputJson {
  if (value !== null && typeof value === 'object' && immutableOutputJson.has(value)) return value
  // Validate before any object enumeration can invoke a getter or drop a hidden
  // field. This is the new output contract; historical hash functions are unchanged.
  serializeOutputCanonicalJson(value)
  return freezeValidatedOutputJson(value)
}
function freezeValidatedOutputJson(value: OutputJson): OutputJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    assertDomain(Number.isFinite(value), 'INVALID_OUTPUT_SPEC', 'Non-finite output dependency')
    return value
  }
  assertDomain(typeof value === 'object', 'INVALID_OUTPUT_SPEC', 'Non-JSON output dependency')
  if (immutableOutputJson.has(value)) return value
  if (Array.isArray(value)) {
    assertDomain(Object.keys(value).length === value.length, 'INVALID_OUTPUT_SPEC', 'Sparse output dependency')
    const frozen = Object.freeze(value.map(freezeValidatedOutputJson))
    immutableOutputJson.add(frozen)
    return frozen
  }
  assertDomain(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'INVALID_OUTPUT_SPEC', 'Output dependency must be a JSON object')
  const frozen = Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeValidatedOutputJson(nested)])))
  immutableOutputJson.add(frozen)
  return frozen
}
export function validateOutputProvenance(input: OutputProvenance): void {
  assertDomain(['creation-command', 'edit-command', 'media-ingest-operation'].includes(input.kind),
    'INVALID_OUTPUT_SPEC', 'Unsupported output provenance')
  requireOutputId(input.id, 'provenance.id')
  requireOutputHash(input.hash, 'provenance.hash')
}
function canonicalOutputDate(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
export function validateSealedOutputDocument(input: SealedOutputDocument): void {
  assertDomain(typeof input.schemaVersion === 'string' && /^[a-z0-9-]+\/v[1-9][0-9]*$/.test(input.schemaVersion),
    'INVALID_OUTPUT_SPEC', 'Output dependency requires an explicit versioned schema')
  const document = freezeOutputJson(input.document)
  validateOutputCanonicalPolicy(document)
  assertDomain(document !== null && typeof document === 'object' && !Array.isArray(document) &&
    (document as Record<string, OutputJson>).schemaVersion === input.schemaVersion,
  'INVALID_OUTPUT_SPEC', 'Output dependency schema/document mismatch')
  requireOutputHash(input.hash, 'dependency.hash')
  assertDomain(calculateOutputCanonicalHash(document) === input.hash,
    'INVALID_OUTPUT_SPEC', 'Output dependency document hash mismatch')
}
export function createOutputVariant(input: OutputVariant): Readonly<OutputVariant> {
  requireOutputId(input.id, 'variant.id')
  requireOutputId(input.workspaceId, 'workspaceId')
  requireOutputId(input.projectId, 'projectId')
  validateOutputProvenance(input.createdCommand)
  assertDomain(input.createdCommand.kind !== ('media-ingest-operation' as string),
    'INVALID_OUTPUT_SPEC', 'Only explicit Commands create variants')
  assertDomain(canonicalOutputDate(input.createdAt),
    'INVALID_OUTPUT_SPEC', 'Variant timestamp must be canonical UTC')
  return Object.freeze({ ...input, createdCommand: Object.freeze({ ...input.createdCommand }) })
}

function validateEncoding(input: MaterializedOutputEncoding, kind: 'final' | 'proxy', output: OutputSpec): void {
  assertDomain(input.codec === 'h264' && input.encoder === 'libx264' && input.pixelFormat === 'yuv420p' &&
    input.container === 'mp4' && input.faststart === true,
  'INVALID_OUTPUT_SPEC', 'Unsupported effective output encoding')
  createOutputSpec({ id: output.id, locale: output.locale, aspectRatio: output.aspectRatio,
    width: input.width, height: input.height, fps: input.fps, safeArea: output.safeArea })
  assertDomain(input.fps === output.fps && (kind !== 'final' ||
    (input.width === output.width && input.height === output.height)),
  'INVALID_OUTPUT_SPEC', 'Delivery canvas/fps contradicts OutputSpec')
  assertDomain(input.quality.mode === 'crf' && input.quality.value === (kind === 'final' ? 18 : 23) &&
    input.quality.preset === (kind === 'final' ? 'medium' : 'veryfast'),
  'INVALID_OUTPUT_SPEC', 'Quality settings do not match the versioned renderer contract')
  assertDomain(input.audio.codec === 'aac' && input.audio.bitrateKbps === (kind === 'final' ? 192 : 160) &&
    input.audio.sampleRateHz === 48000 && Number.isInteger(input.audio.channels) &&
    input.audio.channels >= 1 && input.audio.channels <= 8,
  'INVALID_OUTPUT_SPEC', 'Audio settings must be effective and explicit')
}
export function createOutputSpecRevisionBody(
  input: Omit<OutputSpecRevisionBody, 'schemaVersion'>,
): Readonly<OutputSpecRevisionBody> {
  validateOutputCanonicalPolicy(input)
  for (const [key, value] of Object.entries({ id: input.id, variantId: input.variantId,
    workspaceId: input.workspaceId, projectId: input.projectId })) requireOutputId(value, key)
  assertDomain(Number.isInteger(input.revisionNumber) && input.revisionNumber >= 1,
    'INVALID_OUTPUT_SPEC', 'Revision number must be positive')
  const output = createOutputSpec(input.output)
  assertDomain(output.id === input.variantId, 'INVALID_OUTPUT_SPEC', 'Output identity must be its stable variant')
  const profile = input.profile
  requireOutputId(profile.id, 'deliveryProfile.id')
  assertDomain(profile.schemaVersion === 'materialized-delivery-profile/v1' &&
    profile.rendererContractVersion === 'ffmpeg-editorial-output/v1' &&
    Number.isInteger(profile.version) && profile.version >= 1,
  'INVALID_OUTPUT_SPEC', 'Delivery profile identity/version is invalid')
  assertDomain(output.deliveryProfileId === profile.id,
    'INVALID_OUTPUT_SPEC', 'OutputSpec requires its exact materialized delivery profile')
  validateEncoding(profile.final, 'final', output)
  validateEncoding(profile.proxy, 'proxy', output)
  assertDomain(profile.proxyToFinal.schemaVersion === 'output-canvas-transform/v1' &&
    profile.proxyToFinal.scaleX === output.width / profile.proxy.width &&
    profile.proxyToFinal.scaleY === output.height / profile.proxy.height,
  'INVALID_OUTPUT_SPEC', 'Proxy-to-final transform must be materialized from exact canvases')
  assertDomain(['none', 'burn-in', 'sidecar'].includes(profile.subtitles.mode),
    'INVALID_OUTPUT_SPEC', 'Subtitle delivery mode must be explicit')
  if (profile.subtitles.mode === 'none') {
    assertDomain(profile.subtitles.configuration === null && profile.subtitles.fontAssets.length === 0,
      'INVALID_OUTPUT_SPEC', 'Disabled subtitle policy must have no implicit configuration/fonts')
  } else {
    assertDomain(profile.subtitles.configuration !== null,
      'INVALID_OUTPUT_SPEC', 'Subtitle delivery requires materialized configuration')
    validateSealedOutputDocument(profile.subtitles.configuration)
    assertDomain(profile.subtitles.mode !== 'burn-in' || profile.subtitles.fontAssets.length > 0,
      'INVALID_OUTPUT_SPEC', 'Burn-in subtitles require exact font artifacts')
  }
  const fonts = new Set<string>()
  for (const font of profile.subtitles.fontAssets) {
    requireOutputId(font.artifactId, 'font.artifactId')
    requireOutputHash(font.sha256, 'font.sha256')
    assertDomain(!fonts.has(font.artifactId), 'INVALID_OUTPUT_SPEC', 'Duplicate font dependency')
    fonts.add(font.artifactId)
  }
  if (input.preset !== null) validateSealedOutputDocument(input.preset)
  assertDomain(canonicalOutputDate(input.createdAt),
    'INVALID_OUTPUT_SPEC', 'Revision timestamp must be canonical UTC')
  const body = { schemaVersion: 'output-spec-revision/v1' as const,
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, id: input.id, variantId: input.variantId,
    workspaceId: input.workspaceId, projectId: input.projectId, revisionNumber: input.revisionNumber,
    output, profile, preset: input.preset, createdAt: input.createdAt }
  return freezeOutputJson(body as unknown as OutputJson) as unknown as Readonly<OutputSpecRevisionBody>
}
export function sealOutputSpecRevision(
  document: OutputSpecRevisionBody,
  createdCommand: OutputSpecRevision['createdCommand'],
): Readonly<OutputSpecRevision> {
  validateOutputProvenance(createdCommand)
  assertDomain(createdCommand.kind !== ('media-ingest-operation' as string),
    'INVALID_OUTPUT_SPEC', 'Only explicit Commands revise outputs')
  const normalized = createOutputSpecRevisionBody(document)
  return Object.freeze({ document: normalized, specHash: calculateOutputCanonicalHash(normalized),
    createdCommand: Object.freeze({ ...createdCommand }) })
}

export interface ForkOutputSpecRevisionBodyV2 extends OutputCanonicalPolicy {
  schemaVersion: 'output-spec-revision/v2'
  id: string
  variantId: string
  workspaceId: string
  projectId: string
  revisionNumber: 1
  source: Readonly<{ projectId: string; variantId: string; revisionId: string; specHash: string }>
  effectiveSpec: Readonly<OutputSpecRevisionBody>
  consumption: Readonly<{ status: 'blocked'; reason: 'fork-target-geometry-unmaterialized' }>
  createdAt: string
}
export function createForkOutputSpecRevisionV2(input: Readonly<{
  id: string; variantId: string; workspaceId: string; projectId: string; createdAt: string;
  source: Readonly<ProjectOutputStateEntrySourceV2>
}>): Readonly<{ document: ForkOutputSpecRevisionBodyV2; specHash: string }> {
  for (const [field, value] of Object.entries({ id: input.id, variantId: input.variantId, workspaceId: input.workspaceId,
    projectId: input.projectId })) requireOutputId(value, field)
  const source = createOutputSpecRevisionBody(input.source.spec)
  assertDomain(source.id === input.source.outputSpecRevisionId && source.variantId === input.source.variantId &&
    calculateOutputCanonicalHash(source) === input.source.specHash && source.workspaceId === input.workspaceId &&
    source.projectId !== input.projectId && source.id !== input.id && source.variantId !== input.variantId,
    'INVALID_OUTPUT_SPEC', 'Fork revision source identity/seal mismatch')
  const effectiveSpec = createOutputSpecRevisionBody({ ...source, id: input.id, variantId: input.variantId,
    workspaceId: input.workspaceId, projectId: input.projectId, revisionNumber: 1, createdAt: input.createdAt,
    output: { ...source.output, id: input.variantId } })
  const document: ForkOutputSpecRevisionBodyV2 = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'output-spec-revision/v2', id: input.id, variantId: input.variantId, workspaceId: input.workspaceId,
    projectId: input.projectId, revisionNumber: 1, source: { projectId: source.projectId, variantId: source.variantId,
      revisionId: source.id, specHash: input.source.specHash }, effectiveSpec,
    consumption: { status: 'blocked', reason: 'fork-target-geometry-unmaterialized' }, createdAt: input.createdAt }
  return Object.freeze({ document: freezeOutputJson(document as unknown as OutputJson) as unknown as ForkOutputSpecRevisionBodyV2,
    specHash: calculateOutputCanonicalHash(document) })
}
export interface ProjectOutputStateEntrySourceV2 {
  variantId: string; outputSpecRevisionId: string; specHash: string; spec: Readonly<OutputSpecRevisionBody>
}

/** A fork of Creation2/Operational3 names the actual source contract. Existing
 * revision1/revision2 seals are checked, never rebuilt as another version. */
export interface ForkOutputSpecRevisionBodyV3 extends Omit<ForkOutputSpecRevisionBodyV2, 'schemaVersion' | 'source'> {
  schemaVersion: 'output-spec-revision/v3'
  source: ForkOutputSpecRevisionBodyV2['source'] & Readonly<{ outputContractVersion: 2 | 3; schemaVersion: 'output-spec-revision/v1' | 'output-spec-revision/v2' | 'output-spec-revision/v3' }>
}
export function createForkOutputSpecRevisionV3(input: Readonly<{
  id: string; variantId: string; workspaceId: string; projectId: string; createdAt: string;
  sourceContractVersion: 2 | 3;
  source: Readonly<{ variantId: string; outputSpecRevisionId: string; specHash: string;
    spec: Readonly<OutputSpecRevisionBody | ForkOutputSpecRevisionBodyV2 | ForkOutputSpecRevisionBodyV3> }>
}>): Readonly<{ document: ForkOutputSpecRevisionBodyV3; specHash: string }> {
  const source = input.source.spec
  requireOutputHash(input.source.specHash, 'fork3 source revision hash')
  assertDomain((input.sourceContractVersion === 2 || input.sourceContractVersion === 3) &&
    calculateOutputCanonicalHash(source) === input.source.specHash && source.id === input.source.outputSpecRevisionId &&
    source.variantId === input.source.variantId && source.workspaceId === input.workspaceId && source.projectId !== input.projectId &&
    source.id !== input.id && source.variantId !== input.variantId && (input.sourceContractVersion === 2
      ? source.schemaVersion === 'output-spec-revision/v2' || source.schemaVersion === 'output-spec-revision/v3' : source.schemaVersion === 'output-spec-revision/v1' || source.schemaVersion === 'output-spec-revision/v3'),
  'INVALID_OUTPUT_SPEC', 'Fork3 revision requires its exact actual source identity/contract/seal')
  const effective = source.schemaVersion === 'output-spec-revision/v1' ? createOutputSpecRevisionBody(source)
    : source.schemaVersion === 'output-spec-revision/v2' || source.schemaVersion === 'output-spec-revision/v3'
      ? createOutputSpecRevisionBody(source.effectiveSpec) : null
  assertDomain(effective !== null && effective.id === source.id && effective.variantId === source.variantId &&
    effective.projectId === source.projectId && effective.workspaceId === source.workspaceId,
  'INVALID_OUTPUT_SPEC', 'Fork3 revision effective source scope differs')
  if (source.schemaVersion !== 'output-spec-revision/v1') assertDomain(source.consumption.status === 'blocked' &&
    source.consumption.reason === 'fork-target-geometry-unmaterialized', 'INVALID_OUTPUT_SPEC', 'Fork3 source cannot claim an invented materializer')
  const effectiveSpec = createOutputSpecRevisionBody({ ...effective, id: input.id, variantId: input.variantId,
    workspaceId: input.workspaceId, projectId: input.projectId, revisionNumber: 1, createdAt: input.createdAt,
    output: { ...effective.output, id: input.variantId } })
  const document: ForkOutputSpecRevisionBodyV3 = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'output-spec-revision/v3', id: input.id, variantId: input.variantId, workspaceId: input.workspaceId,
    projectId: input.projectId, revisionNumber: 1, createdAt: input.createdAt,
    source: { outputContractVersion: input.sourceContractVersion, schemaVersion: source.schemaVersion, projectId: source.projectId,
      variantId: source.variantId, revisionId: source.id, specHash: input.source.specHash }, effectiveSpec,
    consumption: { status: 'blocked', reason: 'fork-target-geometry-unmaterialized' } }
  return Object.freeze({ document: freezeOutputJson(document as unknown as OutputJson) as unknown as ForkOutputSpecRevisionBodyV3,
    specHash: calculateOutputCanonicalHash(document) })
}
