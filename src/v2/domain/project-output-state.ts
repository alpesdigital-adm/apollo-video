import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { createHash } from 'node:crypto'
import { assertDomain } from './errors.ts'
import { validateDirectedEditPlan, type DirectedEditPlan } from './director-run.ts'
import { calculateRenderablePlanHash, renderablePlanAuthorityBody } from './renderable-plan-authority.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION,
  validateOutputCanonicalPolicy, type OutputCanonicalPolicy } from './output-canonical-policy.ts'
import {
  createOutputSpecRevisionBody, freezeOutputJson, requireOutputHash, requireOutputId,
  validateOutputProvenance, validateSealedOutputDocument,
  type OutputJson, type OutputProvenance, type OutputSpecRevisionBody, type SealedOutputDocument,
} from './output-spec-revision.ts'

export const OUTPUT_STATE_TRANSITIONS = ['initialize-empty', 'create-variant', 'revise-output',
  'inherit', 'set-overlay', 'reset-overlay', 'invalidate', 'restore', 'fork-empty'] as const
type GeometrySourceIdentity = Readonly<{ sourceArtifactId: string; sourceManifestId: string;
  sourceManifestHash: string; sourceSha256: string }>
export type OutputGeometryProbeDocument = GeometrySourceIdentity & OutputCanonicalPolicy & Readonly<{
  schemaVersion: 'observed-video-probe/v1'
  width: number; height: number; fps: number; durationFrames: number
  timebase: Readonly<{ numerator: number; denominator: number }>
  orientation: Readonly<{ rotationDegrees: 0; displayTransform: readonly number[] }>
}>
export type OutputGeometryNormalizationDocument = GeometrySourceIdentity & OutputCanonicalPolicy & Readonly<{
  schemaVersion: 'observed-normalization/v1'
  mode: 'verified-source'
  probeHash: string
}>
type SealedGeometryProbe = Readonly<{ schemaVersion: 'observed-video-probe/v1';
  document: OutputGeometryProbeDocument; hash: string }>
type SealedGeometryNormalization = Readonly<{ schemaVersion: 'observed-normalization/v1';
  document: OutputGeometryNormalizationDocument; hash: string }>
export interface OutputGeometryClip {
  id: string
  sourceArtifactId: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceSha256: string
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: 1
  probe: SealedGeometryProbe
  normalization: SealedGeometryNormalization
}
export interface OutputGeometryProjection extends OutputCanonicalPolicy {
  schemaVersion: 'variant-reframe-geometry/v1'
  variantId: string
  output: Readonly<{
    aspectRatio: OutputSpecRevisionBody['output']['aspectRatio']
    width: number
    height: number
    fps: number
    proxyToFinal: OutputSpecRevisionBody['profile']['proxyToFinal']
  }>
  timeline: Readonly<{ fps: number; durationFrames: number; trackId: string }>
  // Render order is authoritative; this array is never sorted by clip ID.
  clips: readonly Readonly<OutputGeometryClip>[]
  composition: Readonly<{
    foregroundScale: Readonly<{ present: boolean; value: number | null }>
    verticalPosition: Readonly<{ present: boolean; value: number | null }>
  }>
  globalCropPresent: false
}
export interface ProjectOutputStateEntry extends OutputCanonicalPolicy {
  variantId: string
  outputSpecRevisionId: string
  specHash: string
  spec: Readonly<OutputSpecRevisionBody>
  geometry: Readonly<
    { status: 'unmaterialized'; projection: null; projectionHash: null } |
    { status: 'verified'; projection: Readonly<OutputGeometryProjection>; projectionHash: string }
  >
}
export interface ProjectOutputStateOverlay extends OutputCanonicalPolicy {
  id: string
  variantId: string
  kind: 'crop'
  clipId: string
  startFrame: number
  endFrame: number
  status: 'active' | 'invalidated'
  provenance: Readonly<OutputProvenance & { kind: 'edit-command' }>
  dependencyHash: string
  document: Readonly<SealedOutputDocument>
}
export interface ProjectOutputStateInvalidation extends OutputCanonicalPolicy {
  id: string
  variantId: string
  overlayId: string | null
  kind: 'crop' | 'render' | 'critic' | 'sidecar'
  reasonCode: string
  previousDependencyHash: string
  nextDependencyHash: string
  provenance: Readonly<OutputProvenance>
  document: Readonly<SealedOutputDocument>
}
export type OutputPlanAuthorityDocument = OutputCanonicalPolicy & Readonly<{
  schemaVersion: 'output-plan-authority/v1'
  kind: 'project-edit-plan' | 'renderable-edit-plan'
  legacyCanonicalJson: string
  legacyHash: string
}>
export type SealedOutputPlanAuthority = Readonly<{ schemaVersion: 'output-plan-authority/v1';
  document: OutputPlanAuthorityDocument; hash: string }>
export interface ProjectOutputStateBody extends OutputCanonicalPolicy {
  schemaVersion: 'project-output-state/v1'
  id: string
  workspaceId: string
  projectId: string
  resultVersionId: string
  parentVersionId: string | null
  parentStateId: string | null
  parentStateHash: string | null
  transition: (typeof OUTPUT_STATE_TRANSITIONS)[number]
  transitionPolicyVersion: 'project-output-transition/v1'
  provenance: Readonly<OutputProvenance>
  producer: Readonly<{ hash: string; document: OutputJson }>
  editPlan: Readonly<{ snapshotId: string; hash: string; authority: SealedOutputPlanAuthority }>
  renderablePlan: Readonly<{ snapshotId: string; planId: string; hash: string; authority: SealedOutputPlanAuthority }> | null
  entries: readonly Readonly<ProjectOutputStateEntry>[]
  overlays: readonly Readonly<ProjectOutputStateOverlay>[]
  invalidations: readonly Readonly<ProjectOutputStateInvalidation>[]
  createdAt: string
}
export interface ProjectOutputState {
  document: Readonly<ProjectOutputStateBody>
  stateHash: string
}
export interface OutputPlanFacts {
  editPlanDocument: OutputJson
  renderablePlanDocument: OutputJson | null
}

type PlanClip = Readonly<Pick<OutputGeometryClip, 'id' | 'sourceArtifactId' | 'sourceInFrame' |
  'sourceOutFrame' | 'timelineInFrame' | 'timelineOutFrame' | 'rate'> & { crop?: unknown }>
type PlanGeometry = Readonly<{
  id: string
  projectVersionId: string
  fps: number
  durationFrames: number
  videoTracks: readonly Readonly<{ id: string; kind: string; clips: readonly PlanClip[] }>[]
  composition?: { foregroundScale?: number; verticalPosition?: number }
}>
function canonicalDate(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
function uniqueIds(values: readonly string[], field: string): void {
  assertDomain(new Set(values).size === values.length, 'INVALID_OUTPUT_SPEC', `Duplicate ${field}`)
  for (const value of values) requireOutputId(value, field)
}
// IDs are validated ASCII tokens. Code-unit comparison is their canonical
// lexical order and does not consult the host locale or ICU version.
function compareOutputIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
function exactGeometryKeys(value: unknown, keys: readonly string[], field: string): void {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
  'INVALID_OUTPUT_SPEC', `Missing or unsupported ${field} fields`)
}
function historicalPlanAuthorityBody(kind: OutputPlanAuthorityDocument['kind'], document: OutputJson): unknown {
  const frozen = freezeOutputJson(document)
  if (kind === 'project-edit-plan') return frozen
  const renderable = frozen as unknown as DirectedEditPlan
  validateDirectedEditPlan(renderable)
  return renderablePlanAuthorityBody(renderable)
}

/** Writers explicitly seal actual persisted/compiled plan facts. Readers never
 * fabricate this envelope when it is missing, and never rehash historical rows. */
export function createOutputPlanAuthority(input: OutputCanonicalPolicy & Readonly<{
  kind: OutputPlanAuthorityDocument['kind']; planDocument: OutputJson
}>): SealedOutputPlanAuthority {
  validateOutputCanonicalPolicy(input)
  assertDomain(['project-edit-plan', 'renderable-edit-plan'].includes(input.kind),
    'INVALID_OUTPUT_SPEC', 'Unsupported plan authority kind')
  const body = historicalPlanAuthorityBody(input.kind, input.planDocument)
  const document: OutputPlanAuthorityDocument = Object.freeze({ schemaVersion: 'output-plan-authority/v1',
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, kind: input.kind,
    legacyCanonicalJson: stableSerialize(body), legacyHash: calculateCanonicalHash(body) })
  return Object.freeze({ schemaVersion: 'output-plan-authority/v1', document,
    hash: calculateOutputCanonicalHash(document) })
}

function validateOutputPlanAuthority(authority: SealedOutputPlanAuthority,
  kind: OutputPlanAuthorityDocument['kind'], planDocument: OutputJson, oldHash: string): void {
  assertDomain(authority !== null && typeof authority === 'object', 'INVALID_OUTPUT_SPEC', 'Missing plan authority seal')
  validateSealedOutputDocument(authority)
  const document = authority.document
  exactGeometryKeys(document, ['schemaVersion', 'canonicalPolicyVersion', 'kind', 'legacyCanonicalJson', 'legacyHash'], 'plan authority')
  const expected = historicalPlanAuthorityBody(kind, planDocument)
  assertDomain(authority.schemaVersion === 'output-plan-authority/v1' && document.kind === kind &&
    typeof document.legacyCanonicalJson === 'string' && document.legacyCanonicalJson === stableSerialize(expected) &&
    document.legacyHash === oldHash && createHash('sha256').update(document.legacyCanonicalJson, 'utf8').digest('hex') === oldHash,
  'INVALID_OUTPUT_SPEC', 'Plan authority text/kind/historical hash mismatch')
}
function validateGeometrySourceFacts(clip: OutputGeometryClip, fps: number): void {
  assertDomain(clip.probe !== null && typeof clip.probe === 'object' &&
    clip.normalization !== null && typeof clip.normalization === 'object',
  'INVALID_OUTPUT_SPEC', 'Geometry requires explicit probe and normalization documents')
  validateSealedOutputDocument(clip.probe)
  validateSealedOutputDocument(clip.normalization)
  assertDomain(clip.probe.schemaVersion === 'observed-video-probe/v1' &&
    clip.normalization.schemaVersion === 'observed-normalization/v1',
  'INVALID_OUTPUT_SPEC', 'Unsupported geometry probe/normalization schema')
  const probe = clip.probe.document, normalization = clip.normalization.document
  const identityFields = ['sourceArtifactId', 'sourceManifestId', 'sourceManifestHash', 'sourceSha256'] as const
  exactGeometryKeys(probe, ['schemaVersion', 'canonicalPolicyVersion', ...identityFields, 'width', 'height', 'fps',
    'durationFrames', 'timebase', 'orientation'], 'geometry probe')
  exactGeometryKeys(normalization, ['schemaVersion', 'canonicalPolicyVersion', ...identityFields, 'mode', 'probeHash'], 'geometry normalization')
  for (const field of identityFields) assertDomain(probe[field] === clip[field] && normalization[field] === clip[field],
    'INVALID_OUTPUT_SPEC', 'Geometry probe/normalization source identity contradicts clip')
  requireOutputHash(normalization.probeHash, 'normalization.probeHash')
  assertDomain(normalization.mode === 'verified-source' && normalization.probeHash === clip.probe.hash,
    'INVALID_OUTPUT_SPEC', 'Geometry normalization mode/probe binding is unsupported or contradictory')
  exactGeometryKeys(probe.timebase, ['numerator', 'denominator'], 'probe timebase')
  exactGeometryKeys(probe.orientation, ['rotationDegrees', 'displayTransform'], 'probe orientation')
  assertDomain(Number.isSafeInteger(probe.width) && probe.width > 0 &&
    Number.isSafeInteger(probe.height) && probe.height > 0 && probe.fps === fps &&
    Number.isSafeInteger(probe.durationFrames) && probe.durationFrames >= clip.sourceOutFrame &&
    Number.isSafeInteger(probe.timebase.numerator) && probe.timebase.numerator > 0 &&
    Number.isSafeInteger(probe.timebase.denominator) && probe.timebase.denominator > 0 &&
    probe.orientation.rotationDegrees === 0 && Array.isArray(probe.orientation.displayTransform) &&
    probe.orientation.displayTransform.length === 9 && calculateCanonicalHash(probe.orientation.displayTransform) ===
      calculateCanonicalHash([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  'INVALID_OUTPUT_SPEC', 'Source probe is missing or requires unsupported fps/orientation conversion or source duration')
}
function readPlanGeometry(document: OutputJson, resultVersionId: string): PlanGeometry {
  const plan = document as unknown as PlanGeometry
  assertDomain(plan && Array.isArray(plan.videoTracks) && Number.isInteger(plan.fps) && plan.fps >= 1 &&
    Number.isInteger(plan.durationFrames) && plan.durationFrames >= 0,
  'INVALID_OUTPUT_SPEC', 'Output state requires actual plan geometry')
  for (const track of plan.videoTracks) {
    assertDomain(track && Array.isArray(track.clips), 'INVALID_OUTPUT_SPEC', 'Invalid video track')
  }
  // Even an empty operational root is materialized for its own Version.
  // Unbound historical documents belong only to the separate audit contract.
  assertDomain(Object.hasOwn(plan, 'projectVersionId') && plan.projectVersionId === resultVersionId,
    'INVALID_OUTPUT_SPEC', 'Plan belongs to a different ProjectVersion')
  return plan
}
function readEditPlan(document: OutputJson, hash: string, resultVersionId: string): PlanGeometry {
  assertDomain(calculateCanonicalHash(freezeOutputJson(document)) === hash,
    'INVALID_OUTPUT_SPEC', 'EditPlan document hash mismatch')
  return readPlanGeometry(document, resultVersionId)
}
function readRenderablePlan(document: OutputJson, hash: string, resultVersionId: string): PlanGeometry {
  const frozen = freezeOutputJson(document) as unknown as DirectedEditPlan
  assertDomain(frozen.projectVersionId === resultVersionId && calculateRenderablePlanHash(frozen) === hash,
    'INVALID_OUTPUT_SPEC', 'RenderablePlan authority hash/ProjectVersion mismatch')
  validateDirectedEditPlan(frozen)
  return readPlanGeometry(document, resultVersionId)
}
function validateProjection(projection: OutputGeometryProjection, entry: ProjectOutputStateEntry,
  plan: PlanGeometry): void {
  validateOutputCanonicalPolicy(projection)
  const output = entry.spec.output
  const tracks = plan.videoTracks.filter((track) => track.kind === 'base-video')
  assertDomain(plan.videoTracks.length === 1 && tracks.length === 1 && tracks[0].clips.length > 0,
    'INVALID_OUTPUT_SPEC', 'Verified geometry requires exactly one supported video track')
  assertDomain(projection.schemaVersion === 'variant-reframe-geometry/v1' && projection.variantId === entry.variantId &&
    projection.output.aspectRatio === output.aspectRatio && projection.output.width === output.width &&
    projection.output.height === output.height && projection.output.fps === output.fps &&
    calculateOutputCanonicalHash(projection.output.proxyToFinal) === calculateOutputCanonicalHash(entry.spec.profile.proxyToFinal) &&
    projection.timeline.fps === plan.fps && projection.timeline.durationFrames === plan.durationFrames &&
    projection.timeline.trackId === tracks[0].id && plan.fps === output.fps && projection.globalCropPresent === false,
  'INVALID_OUTPUT_SPEC', 'Geometry output/timeline binding mismatch')
  assertDomain(projection.clips.length === tracks[0].clips.length, 'INVALID_OUTPUT_SPEC', 'Geometry omitted video clips')
  uniqueIds(projection.clips.map((clip) => clip.id), 'geometry.clip.id')
  let previousEnd = 0
  projection.clips.forEach((clip, index) => {
    const rendered = tracks[0].clips[index]
    for (const field of ['id', 'sourceArtifactId', 'sourceInFrame', 'sourceOutFrame',
      'timelineInFrame', 'timelineOutFrame', 'rate'] as const) {
      assertDomain(clip[field] === rendered[field], 'INVALID_OUTPUT_SPEC', 'Geometry differs from actual render order/source/map')
    }
    assertDomain(rendered.crop === undefined && clip.rate === 1 &&
      [clip.sourceInFrame, clip.sourceOutFrame, clip.timelineInFrame, clip.timelineOutFrame].every(Number.isInteger) &&
      clip.sourceInFrame >= 0 && clip.sourceOutFrame > clip.sourceInFrame && clip.timelineInFrame === previousEnd &&
      clip.timelineOutFrame - clip.timelineInFrame === clip.sourceOutFrame - clip.sourceInFrame,
    'INVALID_OUTPUT_SPEC', 'Unsupported crop/rate/temporal geometry')
    previousEnd = clip.timelineOutFrame
    requireOutputId(clip.sourceArtifactId, 'sourceArtifactId')
    requireOutputId(clip.sourceManifestId, 'sourceManifestId')
    requireOutputHash(clip.sourceManifestHash, 'sourceManifestHash')
    requireOutputHash(clip.sourceSha256, 'sourceSha256')
    validateGeometrySourceFacts(clip, plan.fps)
  })
  assertDomain(previousEnd === plan.durationFrames, 'INVALID_OUTPUT_SPEC', 'Geometry duration differs from actual video')
  for (const field of ['foregroundScale', 'verticalPosition'] as const) {
    const observed = projection.composition[field]
    const actual = plan.composition?.[field]
    assertDomain(observed.present === (actual !== undefined) && observed.value === (actual ?? null),
      'INVALID_OUTPUT_SPEC', 'Composition presence/value mismatch')
  }
}
function validateOverlayDocument(overlay: ProjectOutputStateOverlay): void {
  validateSealedOutputDocument(overlay.document)
  const document = overlay.document.document as Record<string, OutputJson>
  assertDomain(overlay.kind === 'crop' && overlay.document.schemaVersion === 'project-output-crop/v1' &&
    document.authority === 'editorial-preference', 'INVALID_OUTPUT_SPEC',
  'Output overlays do not assert detector evidence or facial acceptance')
  const bounds = document.crop as Record<string, OutputJson> | null
  assertDomain(bounds !== null && typeof bounds === 'object' && !Array.isArray(bounds) &&
    ['x', 'y', 'width', 'height'].every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key])) &&
    (bounds.x as number) >= 0 && (bounds.y as number) >= 0 && (bounds.width as number) > 0 && (bounds.height as number) > 0 &&
    (bounds.x as number) + (bounds.width as number) <= 1 && (bounds.y as number) + (bounds.height as number) <= 1,
  'INVALID_OUTPUT_SPEC', 'Output overlay requires explicit normalized bounds')
  assertDomain(Object.keys(document).sort().join(',') === 'authority,canonicalPolicyVersion,crop,schemaVersion',
  'INVALID_OUTPUT_SPEC', 'Unsupported output overlay dependency/authority')
}

export function createProjectOutputState(
  input: Omit<ProjectOutputStateBody, 'schemaVersion' | 'transitionPolicyVersion'>,
  facts: OutputPlanFacts,
): Readonly<ProjectOutputState> {
  validateOutputCanonicalPolicy(input)
  for (const [field, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId,
    projectId: input.projectId, resultVersionId: input.resultVersionId })) requireOutputId(value, field)
  assertDomain(OUTPUT_STATE_TRANSITIONS.includes(input.transition), 'INVALID_OUTPUT_SPEC', 'Unknown output transition')
  validateOutputProvenance(input.provenance)
  assertDomain(input.provenance.kind !== 'creation-command' ||
    ['initialize-empty', 'fork-empty'].includes(input.transition),
  'INVALID_OUTPUT_SPEC', 'CreationCommand can only initialize an empty output state')
  assertDomain(input.parentVersionId !== input.resultVersionId, 'INVALID_OUTPUT_SPEC', 'State cannot parent itself')
  if (input.parentVersionId !== null) requireOutputId(input.parentVersionId, 'parentVersionId')
  if (input.parentStateId !== null) {
    requireOutputId(input.parentStateId, 'parentStateId')
    requireOutputHash(input.parentStateHash, 'parentStateHash')
    assertDomain(input.parentVersionId !== null, 'INVALID_OUTPUT_SPEC', 'Parent state requires parent Version')
  } else assertDomain(input.parentStateHash === null, 'INVALID_OUTPUT_SPEC', 'Parent seal must be complete')
  requireOutputHash(input.producer.hash, 'producer.hash')
  validateOutputCanonicalPolicy(input.producer.document)
  assertDomain(calculateOutputCanonicalHash(freezeOutputJson(input.producer.document)) === input.producer.hash,
    'INVALID_OUTPUT_SPEC', 'Version producer payload seal mismatch')
  assertDomain(input.producer.document !== null && typeof input.producer.document === 'object' &&
    !Array.isArray(input.producer.document) &&
    typeof (input.producer.document as Record<string, OutputJson>).schemaVersion === 'string',
  'INVALID_OUTPUT_SPEC', 'Version producer requires a declared payload schema')
  requireOutputId(input.editPlan.snapshotId, 'editPlan.snapshotId')
  requireOutputHash(input.editPlan.hash, 'editPlan.hash')
  const editPlan = readEditPlan(facts.editPlanDocument, input.editPlan.hash, input.resultVersionId)
  validateOutputPlanAuthority(input.editPlan.authority, 'project-edit-plan', facts.editPlanDocument, input.editPlan.hash)
  let plan = editPlan
  if (input.renderablePlan !== null) {
    assertDomain(facts.renderablePlanDocument !== null, 'INVALID_OUTPUT_SPEC', 'Missing alternate renderable plan')
    requireOutputHash(input.renderablePlan.hash, 'renderablePlan.hash')
    assertDomain(input.renderablePlan.snapshotId.length > 0 && input.renderablePlan.snapshotId.length <= 200 &&
      input.renderablePlan.planId.length > 0 && input.renderablePlan.planId.length <= 200,
    'INVALID_OUTPUT_SPEC', 'Invalid alternate plan identity')
    plan = readRenderablePlan(facts.renderablePlanDocument, input.renderablePlan.hash, input.resultVersionId)
    validateOutputPlanAuthority(input.renderablePlan.authority, 'renderable-edit-plan',
      facts.renderablePlanDocument, input.renderablePlan.hash)
    assertDomain(plan.id === input.renderablePlan.planId, 'INVALID_OUTPUT_SPEC', 'Alternate plan identity mismatch')
  } else assertDomain(facts.renderablePlanDocument === null, 'INVALID_OUTPUT_SPEC', 'Unbound alternate renderable plan')
  uniqueIds(input.entries.map((entry) => entry.variantId), 'entry.variantId')
  uniqueIds(input.overlays.map((overlay) => overlay.id), 'overlay.id')
  uniqueIds(input.invalidations.map((issue) => issue.id), 'invalidation.id')
  const entries = new Map(input.entries.map((entry) => [entry.variantId, entry]))
  for (const entry of input.entries) {
    validateOutputCanonicalPolicy(entry)
    const spec = createOutputSpecRevisionBody(entry.spec)
    assertDomain(entry.outputSpecRevisionId === spec.id && entry.variantId === spec.variantId &&
      spec.projectId === input.projectId && spec.workspaceId === input.workspaceId &&
      calculateOutputCanonicalHash(spec) === entry.specHash,
    'INVALID_OUTPUT_SPEC', 'Revision is not sealed to this exact state entry')
    if (entry.geometry.status === 'unmaterialized') {
      assertDomain(entry.geometry.projection === null && entry.geometry.projectionHash === null &&
        plan.videoTracks.every((track) => track.clips.length === 0),
      'INVALID_OUTPUT_SPEC', 'Referenced video cannot bypass probe checks as unmaterialized')
    } else {
      assertDomain(entry.geometry.status === 'verified', 'INVALID_OUTPUT_SPEC', 'Invalid geometry state')
      validateProjection(entry.geometry.projection, entry, plan)
      requireOutputHash(entry.geometry.projectionHash, 'geometry.projectionHash')
      assertDomain(calculateOutputCanonicalHash(entry.geometry.projection) === entry.geometry.projectionHash,
        'INVALID_OUTPUT_SPEC', 'Geometry projection seal mismatch')
    }
  }
  const hasReferencedVideo = [editPlan, plan].some((candidate) =>
    candidate.videoTracks.some((track) => track.clips.length > 0))
  assertDomain(!hasReferencedVideo || input.entries.some((entry) => entry.geometry.status === 'verified'),
    'INVALID_OUTPUT_SPEC', 'Referenced video requires an explicit verified output entry')
  for (const overlay of input.overlays) {
    validateOutputCanonicalPolicy(overlay)
    const entry = entries.get(overlay.variantId)
    assertDomain(entry !== undefined, 'INVALID_OUTPUT_SPEC', 'Overlay is not a member of this state')
    assertDomain(overlay.kind === 'crop' &&
      ['active', 'invalidated'].includes(overlay.status), 'INVALID_OUTPUT_SPEC', 'Invalid overlay kind/status')
    validateOutputProvenance(overlay.provenance)
    assertDomain(overlay.provenance.kind === 'edit-command', 'INVALID_OUTPUT_SPEC', 'Overlay requires its original Command')
    requireOutputId(overlay.clipId, 'overlay.clipId')
    requireOutputHash(overlay.dependencyHash, 'overlay.dependencyHash')
    validateOverlayDocument(overlay)
    assertDomain(Number.isInteger(overlay.startFrame) && overlay.startFrame >= 0 &&
      Number.isInteger(overlay.endFrame) && overlay.endFrame > overlay.startFrame,
    'INVALID_OUTPUT_SPEC', 'Invalid overlay range')
    if (overlay.status === 'active') {
      assertDomain(entry.geometry.status === 'verified', 'INVALID_OUTPUT_SPEC', 'Active overlay requires verified geometry')
      const clip = entry.geometry.projection.clips.find((candidate) => candidate.id === overlay.clipId)
      assertDomain(clip !== undefined && overlay.startFrame >= clip.timelineInFrame && overlay.endFrame <= clip.timelineOutFrame,
        'INVALID_OUTPUT_SPEC', 'Active overlay range is outside its clip')
      if (overlay.kind === 'crop') assertDomain(overlay.dependencyHash === entry.geometry.projectionHash,
        'INVALID_OUTPUT_SPEC', 'Active crop uses stale geometry')
    } else assertDomain(input.invalidations.some((issue) => issue.overlayId === overlay.id && issue.variantId === overlay.variantId),
      'INVALID_OUTPUT_SPEC', 'Invalidated overlay requires a preserved issue')
  }
  for (let index = 0; index < input.overlays.length; index++) {
    const overlay = input.overlays[index]
    assertDomain(!input.overlays.slice(index + 1).some((other) => overlay.status === 'active' && other.status === 'active' &&
      overlay.variantId === other.variantId && overlay.clipId === other.clipId && overlay.kind === other.kind &&
      overlay.startFrame < other.endFrame && other.startFrame < overlay.endFrame),
    'INVALID_OUTPUT_SPEC', 'Overlapping active overlay ranges require an explicit resolution')
  }
  for (const issue of input.invalidations) {
    validateOutputCanonicalPolicy(issue)
    assertDomain(['crop', 'render', 'critic', 'sidecar'].includes(issue.kind), 'INVALID_OUTPUT_SPEC', 'Unsupported output invalidation kind')
    assertDomain(entries.has(issue.variantId), 'INVALID_OUTPUT_SPEC', 'Invalidation is not a member of this state')
    requireOutputHash(issue.previousDependencyHash, 'previousDependencyHash')
    requireOutputHash(issue.nextDependencyHash, 'nextDependencyHash')
    assertDomain(/^[A-Z][A-Z0-9_]{2,79}$/.test(issue.reasonCode), 'INVALID_OUTPUT_SPEC', 'Invalid invalidation reason code')
    validateOutputProvenance(issue.provenance)
    validateSealedOutputDocument(issue.document)
    if (issue.overlayId !== null) assertDomain(input.overlays.some((overlay) => overlay.id === issue.overlayId &&
      overlay.variantId === issue.variantId && overlay.status === 'invalidated'),
    'INVALID_OUTPUT_SPEC', 'Invalidation must retain its disabled overlay')
  }
  if (input.transition === 'initialize-empty' || input.transition === 'fork-empty') {
    assertDomain(input.parentVersionId === null && input.provenance.kind === 'creation-command' &&
      input.entries.length === 0 && input.overlays.length === 0 && input.invalidations.length === 0 &&
      [editPlan, plan].every((candidate) => candidate.durationFrames === 0 &&
        candidate.videoTracks.every((track) => track.clips.length === 0)),
    'INVALID_OUTPUT_SPEC', 'Bootstrap/fork must be explicitly empty')
  }
  assertDomain(canonicalDate(input.createdAt), 'INVALID_OUTPUT_SPEC', 'State timestamp must be canonical UTC')
  const body = { schemaVersion: 'project-output-state/v1' as const, canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    id: input.id, workspaceId: input.workspaceId,
    projectId: input.projectId, resultVersionId: input.resultVersionId, parentVersionId: input.parentVersionId,
    parentStateId: input.parentStateId, parentStateHash: input.parentStateHash, transition: input.transition,
    transitionPolicyVersion: 'project-output-transition/v1' as const, provenance: input.provenance, producer: input.producer,
    editPlan: input.editPlan, renderablePlan: input.renderablePlan,
    entries: [...input.entries].sort((left, right) => compareOutputIds(left.variantId, right.variantId)),
    overlays: [...input.overlays].sort((left, right) => compareOutputIds(left.id, right.id)),
    invalidations: [...input.invalidations].sort((left, right) => compareOutputIds(left.id, right.id)), createdAt: input.createdAt }
  const frozen = freezeOutputJson(body as unknown as OutputJson) as unknown as Readonly<ProjectOutputStateBody>
  return Object.freeze({ document: frozen, stateHash: calculateOutputCanonicalHash(frozen) })
}

export function outputBoundVersionHashBody(input: {
  workspaceId: string; projectId: string; resultVersionId: string; parentVersionId: string | null;
  previousBaseHash: string | null; producerHash: string; outputStateId: string; outputStateHash: string;
}) {
  return Object.freeze({ schemaVersion: 'project-version-output-state/v1' as const,
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, workspaceId: input.workspaceId,
    projectId: input.projectId, resultVersionId: input.resultVersionId, parentVersionId: input.parentVersionId,
    previousBaseHash: input.previousBaseHash, producerHash: input.producerHash,
    outputStateId: input.outputStateId, outputStateHash: input.outputStateHash })
}

export function calculateOutputBoundVersionHash(input: Parameters<typeof outputBoundVersionHashBody>[0]): string {
  return calculateOutputCanonicalHash(outputBoundVersionHashBody(input))
}

/** Inputs must come from the owned operation and persisted manifest/transcript.
 * SQL scope/seal FKs and its deferred check revalidate these facts on commit.
 * This is the existing worker's deterministic identity, not a synthetic Command.
 */
export function createIngestOutputVersionProducer(input: {
  operationId: string; workspaceId: string; projectId: string; requestFingerprint: string;
  sourceArtifactId: string; sourceManifestId: string; sourceManifestHash: string;
  transcriptId: string; transcriptHash: string; editPlanHash: string;
}): Readonly<{
  resultVersionId: string; editPlanSnapshotId: string; editPlanId: string;
  provenance: Readonly<OutputProvenance>;
  producer: ProjectOutputStateBody['producer'];
}> {
  for (const field of ['operationId', 'workspaceId', 'projectId', 'sourceArtifactId',
    'sourceManifestId', 'transcriptId'] as const) requireOutputId(input[field], field)
  for (const field of ['requestFingerprint', 'sourceManifestHash', 'transcriptHash', 'editPlanHash'] as const)
    requireOutputHash(input[field], field)
  const identity = createHash('sha256').update(`${input.operationId}:${input.sourceArtifactId}:${input.sourceManifestId}:${input.transcriptHash}`)
    .digest('hex').slice(0, 48)
  const resultVersionId = `project-version-ingest-${identity}`
  const editPlanSnapshotId = `project-snapshot-ingest-${identity}`
  const document = Object.freeze({ schemaVersion: 'ingested-source-project-version/v2',
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, operationId: input.operationId,
    workspaceId: input.workspaceId, projectId: input.projectId, resultVersionId,
    sourceArtifactId: input.sourceArtifactId, sourceManifestId: input.sourceManifestId,
    sourceManifestHash: input.sourceManifestHash, transcriptId: input.transcriptId,
    transcriptHash: input.transcriptHash, editPlanSnapshotId, editPlanHash: input.editPlanHash })
  return Object.freeze({ resultVersionId, editPlanSnapshotId, editPlanId: `edit-plan-ingest-${identity}`,
    provenance: Object.freeze({ kind: 'media-ingest-operation' as const, id: input.operationId, hash: input.requestFingerprint }),
    producer: Object.freeze({ document, hash: calculateOutputCanonicalHash(document) }) })
}

import { validateProjectCreationOutputCommandV2, type ProjectCreationOutputCommandV2 } from './project-creation-command.ts'
import { createForkOutputSpecRevisionV2, createForkOutputSpecRevisionV3, type ForkOutputSpecRevisionBodyV2,
  type ForkOutputSpecRevisionBodyV3 } from './output-spec-revision.ts'
import { indexForkIdentityBijectionV2, forkOwnedIdentities, forkOwnedIdentitiesV3 } from './project-fork-derivation.ts'

/** This producer family can persist content/intent, never grant media execution.
 * A materialized branch needs a reviewed materializer producer, which Creation
 * cannot manufacture. It is explicit in the type and rejected for Creation. */
export type OutputConsumptionV2 = Readonly<
  { status: 'blocked'; reasons: readonly ('empty-project' | 'fork-target-materialization-required')[] } |
  { status: 'materialized'; producerKind: 'materializer'; sourceStateId: string; sourceStateHash: string }
>
export interface ProjectOutputStateBodyV2 extends OutputCanonicalPolicy {
  schemaVersion: 'project-output-state/v2'
  transitionPolicyVersion: 'project-output-transition/v2'
  id: string; workspaceId: string; projectId: string; resultVersionId: string
  parentVersionId: null; parentStateId: null; parentStateHash: null
  transition: 'initialize-empty' | 'fork-with-content'
  provenance: Readonly<{ kind: 'creation-command-v2'; id: string; hash: string }>
  producer: Readonly<{ document: OutputJson; hash: string }>
  editPlan: Readonly<{ snapshotId: string; hash: string; authority: SealedOutputPlanAuthority }>
  renderablePlan: Readonly<{ status: 'blocked'; candidateId: string; planId: string; planHash: string;
    derivationId: string; derivationHash: string; reason: 'fork-target-materialization-required' }> | null
  entries: readonly Readonly<{ canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION; variantId: string;
    outputSpecRevisionId: string; specHash: string; spec: ForkOutputSpecRevisionBodyV2 | ForkOutputSpecRevisionBodyV3;
    consumption: Readonly<{ status: 'blocked'; reason: 'fork-target-geometry-unmaterialized' }> }>[]
  overlays: readonly Readonly<{ id: string; variantId: string; clipId: string;
    status: 'inactive-requires-target-materialization'; sourceOverlayId: string; sourceOverlayHash: string;
    author: ProjectCreationOutputCommandV2['author']; audit: ProjectCreationOutputCommandV2['audit']; createdAt: string;
    document: SealedOutputDocument }>[]
  invalidations: readonly Readonly<{ id: string; variantId: string; sourceId: string; sourceHash: string;
    kind: ProjectOutputStateInvalidation['kind']; status: 'source-lineage-only' }>[]
  sourceDependencies: Readonly<{ status: 'blocked-source-lineage-only'; sourceProjectId: string; sourceVersionId: string;
    policy: 'no-target-transcript-or-perception-authority/v1' }> | null
  consumption: OutputConsumptionV2
  createdAt: string
}
export interface ProjectOutputStateV2 { document: Readonly<ProjectOutputStateBodyV2>; stateHash: string }
export function createProjectCreationOutputStateV2(commandInput: ProjectCreationOutputCommandV2): Readonly<ProjectOutputStateV2> {
  const command = validateProjectCreationOutputCommandV2(commandInput), p = command.payload, d = p.forkDerivation?.document
  const kernel = d?.kernel.document, policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
  const index = d ? indexForkIdentityBijectionV2(d.schemaVersion === 'project-fork-derivation/v3'
    ? forkOwnedIdentitiesV3(d.kernel.document.source, d.kernel.document.sourceRenderablePlanSnapshot)
    : forkOwnedIdentities(d.kernel.document.source, d.kernel.document.sourceRenderablePlanSnapshot), d.kernel.document.identityMap) : null
  const editPlan = p.snapshots.find((s) => s.kind === 'edit-plan')!
  const entries = d?.schemaVersion === 'project-fork-derivation/v3' ? d.kernel.document.source.state.document.entries.map(source => {
    const revision = createForkOutputSpecRevisionV3({ id: index!.get('revision:' + source.outputSpecRevisionId)!,
      variantId: index!.get('variant:' + source.variantId)!, workspaceId: command.workspaceId,
      projectId: command.projectId, createdAt: command.createdAt, sourceContractVersion: d.kernel.document.source.version.outputContractVersion, source })
    return { ...policy, variantId: revision.document.variantId, outputSpecRevisionId: revision.document.id,
      specHash: revision.specHash, spec: revision.document, consumption: revision.document.consumption }
  }) : (d?.kernel.document.source.state.document.entries ?? []).map((source) => {
    const revision = createForkOutputSpecRevisionV2({ id: index!.get('revision:' + source.outputSpecRevisionId)!,
      variantId: index!.get('variant:' + source.variantId)!, workspaceId: command.workspaceId,
      projectId: command.projectId, createdAt: command.createdAt, source })
    return { ...policy, variantId: revision.document.variantId, outputSpecRevisionId: revision.document.id,
      specHash: revision.specHash, spec: revision.document, consumption: revision.document.consumption }
  })
  const producerDocument = { ...policy, schemaVersion: 'project-creation-output-producer/v2',
    commandId: command.id, commandHash: command.commandHash, payloadHash: command.payloadHash,
    requestFingerprint: command.requestFingerprint, actorContextHash: command.actorContextHash }
  const document: ProjectOutputStateBodyV2 = { ...policy, schemaVersion: 'project-output-state/v2',
    transitionPolicyVersion: 'project-output-transition/v2', id: p.allocations.stateId,
    workspaceId: command.workspaceId, projectId: command.projectId, resultVersionId: command.versionId,
    parentVersionId: null, parentStateId: null, parentStateHash: null, transition: p.callerIntent.kind,
    provenance: { kind: 'creation-command-v2', id: command.id, hash: command.commandHash },
    producer: { document: producerDocument, hash: calculateOutputCanonicalHash(producerDocument) },
    editPlan: { snapshotId: editPlan.id, hash: editPlan.contentHash,
      authority: createOutputPlanAuthority({ ...policy, kind: 'project-edit-plan', planDocument: JSON.parse(editPlan.contentJson) }) },
    renderablePlan: p.renderableCandidate === null ? null : { status: 'blocked', candidateId: p.renderableCandidate.id,
      planId: p.renderableCandidate.planId, planHash: p.renderableCandidate.planHash,
      derivationId: d!.id, derivationHash: p.forkDerivation!.derivationHash, reason: 'fork-target-materialization-required' },
    entries,
    overlays: (kernel?.cropDecisions ?? []).map((decision) => ({ id: decision.newOverlayId,
      variantId: decision.newVariantId, clipId: decision.newClipId, status: 'inactive-requires-target-materialization' as const,
      sourceOverlayId: decision.sourceOverlayId, sourceOverlayHash: decision.sourceOverlayHash,
      author: command.author, audit: command.audit, createdAt: command.createdAt, document: decision.copiedDocument })),
    invalidations: (kernel?.source.state.document.invalidations ?? []).map((issue) => ({
      id: index!.get('invalidation:' + issue.id)!, variantId: index!.get('variant:' + issue.variantId)!,
      sourceId: issue.id, sourceHash: calculateOutputCanonicalHash(issue), kind: issue.kind, status: 'source-lineage-only' as const })),
    sourceDependencies: kernel ? { status: 'blocked-source-lineage-only', sourceProjectId: kernel.source.version.projectId,
      sourceVersionId: kernel.source.version.id, policy: 'no-target-transcript-or-perception-authority/v1' } : null,
    consumption: { status: 'blocked', reasons: [kernel ? 'fork-target-materialization-required' : 'empty-project'] },
    createdAt: command.createdAt }
  return Object.freeze({ document: freezeOutputJson(document as unknown as OutputJson) as unknown as Readonly<ProjectOutputStateBodyV2>,
    stateHash: calculateOutputCanonicalHash(document) })
}
export function validateProjectCreationOutputStateV2(state: ProjectOutputStateV2, command: ProjectCreationOutputCommandV2): Readonly<ProjectOutputStateV2> {
  const expected = createProjectCreationOutputStateV2(command)
  assertDomain(state.stateHash === expected.stateHash && calculateOutputCanonicalHash(state.document) === expected.stateHash,
    'INVALID_PROJECT_VERSION', 'Creation State2 differs from its exact Command content/allocations')
  return expected
}
export function requireOutputStateConsumableV2(state: ProjectOutputStateV2, purpose: 'render' | 'critic' | 'final'): never {
  assertDomain(['render', 'critic', 'final'].includes(purpose) && state.document.schemaVersion === 'project-output-state/v2' &&
    calculateOutputCanonicalHash(state.document) === state.stateHash, 'PERSISTENCE_CONFLICT', 'Output State2 consumption identity/seal mismatch')
  // No existing Creation producer proves target geometry/normalization/clock.
  // Reject even a resealed forged materialized flag; no arbitrary receipt hash
  // or nullable field grants consumption. Other producer families need contracts.
  assertDomain(false, 'PRECONDITION_REQUIRED', 'Output State2 requires target materialization before consumption',
    { purpose, outputStateId: state.document.id, reasons: state.document.consumption.status === 'blocked'
      ? state.document.consumption.reasons : ['unsupported-materializer-producer'] })
}


// Operational children are a new contract. Bodies and hashes of v1/v2 above
// remain historical authorities; no discriminator upgrade or empty fallback.
import type { OutputMaterializationV3, EditorialDerivedMaterializationV1 } from './output-materialization.ts'
export interface OutputStateEntryV3 extends OutputCanonicalPolicy {
  variantId: string
  outputSpecRevisionId: string
  specHash: string
  spec: Readonly<OutputSpecRevisionBody|ForkOutputSpecRevisionBodyV3>
  consumption: Readonly<
    { status: 'blocked'; reasons: readonly ('empty-project' | 'normalization-required' | 'audio-authority-required')[] } |
    { status: 'materialized'; materialization: Readonly<OutputMaterializationV3|EditorialDerivedMaterializationV1> }
  >
}
export interface ProjectOutputStateBodyV3 extends OutputCanonicalPolicy {
  schemaVersion: 'project-output-state/v3'
  transitionPolicyVersion: 'project-output-transition/v3'
  id: string; workspaceId: string; projectId: string; resultVersionId: string
  parentVersionId: string; parentStateId: string; parentStateHash: string
  transition: 'create-variant' | 'revise-output' | 'ingest' | 'inherit' | 'restore' | 'editorial-cut'
  provenance: Readonly<{ kind: 'edit-command' | 'media-ingest-operation'; id: string; hash: string }>
  producer: Readonly<{ document: OutputJson; hash: string }>
  editPlan: Readonly<{ snapshotId: string; hash: string; authority: SealedOutputPlanAuthority }>
  renderablePlan: Readonly<{ snapshotId: string; planId: string; hash: string; authority: SealedOutputPlanAuthority }> | null
  entries: readonly Readonly<OutputStateEntryV3>[]
  /** Inactive intent is retained, not promoted to verified crop/critic state. */
  overlays: ProjectOutputStateBodyV2['overlays']
  invalidations: ProjectOutputStateBodyV2['invalidations']
  sourceDependencies: ProjectOutputStateBodyV2['sourceDependencies']
  createdAt: string
}
export interface ProjectOutputStateV3 { document: Readonly<ProjectOutputStateBodyV3>; stateHash: string }
export function createProjectOutputStateV3(input: ProjectOutputStateBodyV3, facts: OutputPlanFacts): Readonly<ProjectOutputStateV3> {
  const d=freezeOutputJson(input as unknown as OutputJson) as unknown as Readonly<ProjectOutputStateBodyV3>
  exactGeometryKeys(d,['schemaVersion','canonicalPolicyVersion','transitionPolicyVersion','id','workspaceId','projectId',
    'resultVersionId','parentVersionId','parentStateId','parentStateHash','transition','provenance','producer',
    'editPlan','renderablePlan','entries','overlays','invalidations','sourceDependencies','createdAt'],'State3')
  validateOutputCanonicalPolicy(d)
  assertDomain(d.schemaVersion==='project-output-state/v3' && d.transitionPolicyVersion==='project-output-transition/v3' &&
    ['create-variant','revise-output','ingest','inherit','restore','editorial-cut'].includes(d.transition),
    'INVALID_PROJECT_VERSION','Unsupported State3 transition')
  for(const [k,v] of Object.entries({id:d.id,workspaceId:d.workspaceId,projectId:d.projectId,resultVersionId:d.resultVersionId,
    parentVersionId:d.parentVersionId,parentStateId:d.parentStateId}))requireOutputId(v,k)
  requireOutputHash(d.parentStateHash,'parent State3 seal'); requireOutputHash(d.provenance.hash,'State3 provenance')
  assertDomain(canonicalDate(d.createdAt) && d.id!==d.parentStateId && d.resultVersionId!==d.parentVersionId,
    'INVALID_PROJECT_VERSION','State3 requires new identity and canonical time')
  assertDomain((d.transition==='ingest')===(d.provenance.kind==='media-ingest-operation') &&
    calculateOutputCanonicalHash(d.producer.document)===d.producer.hash,
    'INVALID_PROJECT_VERSION','State3 producer kind/seal differs')
  validateOutputPlanAuthority(d.editPlan.authority,'project-edit-plan',facts.editPlanDocument,d.editPlan.hash)
  const plan=facts.editPlanDocument as Record<string,OutputJson>
  assertDomain(plan.projectVersionId===d.resultVersionId,'INVALID_PROJECT_VERSION','State3 EditPlan Version differs')
  assertDomain((d.renderablePlan===null)===(facts.renderablePlanDocument===null),
    'INVALID_PROJECT_VERSION','State3 renderable presence differs')
  if(d.renderablePlan!==null) {
    validateOutputPlanAuthority(d.renderablePlan.authority,'renderable-edit-plan',facts.renderablePlanDocument!,d.renderablePlan.hash)
    const r=facts.renderablePlanDocument as Record<string,OutputJson>
    assertDomain(r.id===d.renderablePlan.planId && r.projectVersionId===d.resultVersionId,
      'INVALID_PROJECT_VERSION','State3 renderable identity differs')
  }
  uniqueIds(d.entries.map(e=>e.variantId),'State3 members')
  assertDomain(d.entries.length>0,'INVALID_PROJECT_VERSION','Child3 requires explicit variant membership')
  for(const e of d.entries) {
    exactGeometryKeys(e,['canonicalPolicyVersion','variantId','outputSpecRevisionId','specHash','spec','consumption'],'State3 entry')
    validateOutputCanonicalPolicy(e)
    const spec=e.spec.schemaVersion==='output-spec-revision/v1'?createOutputSpecRevisionBody(e.spec):e.spec
    if(spec.schemaVersion==='output-spec-revision/v3') {
      const effective=createOutputSpecRevisionBody(spec.effectiveSpec)
      assertDomain(effective.id===spec.id&&effective.variantId===spec.variantId&&effective.workspaceId===spec.workspaceId&&
        effective.projectId===spec.projectId&&spec.consumption.status==='blocked'&&spec.consumption.reason==='fork-target-geometry-unmaterialized',
        'INVALID_PROJECT_VERSION','State3 must retain its literal immutable fork revision, not upgrade its authority')
    }
    assertDomain(spec.workspaceId===d.workspaceId && spec.projectId===d.projectId &&
      spec.id===e.outputSpecRevisionId && spec.variantId===e.variantId && calculateOutputCanonicalHash(spec)===e.specHash,
      'INVALID_PROJECT_VERSION','State3 revision identity/seal differs')
    if(e.consumption.status==='blocked') {
      exactGeometryKeys(e.consumption,['status','reasons'],'blocked consumption')
      assertDomain(e.consumption.reasons.length>0 && new Set(e.consumption.reasons).size===e.consumption.reasons.length &&
        e.consumption.reasons.every(r=>['empty-project','normalization-required','audio-authority-required'].includes(r)),
        'INVALID_PROJECT_VERSION','State3 blocked reasons invalid')
    } else {
      exactGeometryKeys(e.consumption,['status','materialization'],'materialized consumption')
      const m=e.consumption.materialization
      assertDomain(e.consumption.status==='materialized' && ['output-materialization/v3','editorial-derived-materialization/v1'].includes(m.document.schemaVersion) &&
        calculateOutputCanonicalHash(m.document)===m.materializationHash && m.document.workspaceId===d.workspaceId &&
        m.document.projectId===d.projectId && m.document.resultVersionId===d.resultVersionId &&
        m.document.variantId===e.variantId && m.document.outputSpecRevisionId===e.outputSpecRevisionId &&
        m.document.specHash===e.specHash && m.document.planSnapshotId===d.editPlan.snapshotId && m.document.planHash===d.editPlan.hash,
        'INVALID_PROJECT_VERSION','State3 materialization identity/seal differs')
    }
  }
  return Object.freeze({document:d,stateHash:calculateOutputCanonicalHash(d)})
}
