import { createEditorialAudioTimelineHash } from './production-modes.ts'
import { assertMediaArtifactManifest } from './media-artifact.ts'
import { createHash } from 'node:crypto'
import { createApiAccessAuditContext, type ApiAccessAuditContext } from './api-access-control.ts'
import { validateManualGesture, type ManualGesture } from './manual-editing.ts'
import { normalizeProjectName, PROJECT_STATUSES } from './project.ts'
import { assertDomain } from './errors.ts'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { createProjectSnapshot, type ProjectSnapshot } from './project-snapshot.ts'
import { rebuildRetiredContractOneVersion } from './project-version.ts'
import { createProjectOutputState, outputBoundVersionHashBody } from './project-output-state.ts'
import { freezeOutputJson, type OutputJson } from './output-spec-revision.ts'
import type { OutputOriginAllocation, ForkCropDecisionDraft } from './output-version-origin.ts'
import type { OutputVersionBundle } from './output-version-bundle.ts'
import { serializeOutputCanonicalJson, calculateOutputCanonicalHash, validateOutputCanonicalPolicy, type OutputCanonicalPolicy, OUTPUT_CANONICAL_POLICY_VERSION } from './output-canonical-policy.ts'
import { validateDirectedEditPlan, createDirectedAudioTimelineHash, type DirectedEditPlan } from './director-run.ts'
import { rebindSnapshotContentForDuplicate } from './project-snapshot-rebind.ts'
import { calculateRenderablePlanHash } from './renderable-plan-authority.ts'
import { validateCreationOutputVersionBundleV2, operationalBundlePlanV3,
  type OperationalOutputParentV3 } from './output-version-bundle.ts'
import { createProjectOutputStateV3 } from './project-output-state.ts'
import { outputBoundVersionHashBodyV3 } from './project-version.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
function forkExact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
  'INVALID_COMMAND', 'Fork fields are missing or unsupported')
}

export const FORK_IDENTITY_KINDS_V2 = ['version', 'state', 'snapshot', 'edit-plan', 'renderable-plan',
  'renderable-snapshot', 'variant', 'revision', 'overlay', 'invalidation', 'plan-source', 'track', 'clip', 'cue',
  'marker', 'protected-element', 'transition'] as const
export type ForkIdentityKindV2 = (typeof FORK_IDENTITY_KINDS_V2)[number]
export interface ForkIdentityRemapV2 { kind: ForkIdentityKindV2; sourceId: string; targetId: string }

export interface V2RenderablePlanSnapshotFacts {
  readonly id: string; readonly workspaceId: string; readonly projectId: string; readonly projectVersionId: string
  readonly planId: string; readonly origin: 'react-playback' | 'multi-range-synthesis' | 'music-led-montage' | 'localization'
  readonly sourceId: string; readonly sourceHash: string; readonly sourceVersion: number | null
  readonly fps: number; readonly durationFrames: number; readonly clipCount: number
  readonly planJson: string; readonly planHash: string; readonly createdAt: string
}
export interface ForkRenderablePlanMaterializationV2 {
  readonly sourceSnapshotId: string; readonly sourcePlanHash: string
  readonly targetCandidate: Readonly<ForkRenderablePlanCandidate>
  // The copied compilation names the source derivation as lineage only. It is
  // never authority that a target playback/director aggregate was persisted.
  readonly targetDerivationStatus: 'requires-target-materialization'
}
/** Actual separate-table shape and historical plan authority. This validates
 * observed source metadata; it does not attest that a row was persisted. */
export function createV2RenderablePlanSnapshotFacts(input: V2RenderablePlanSnapshotFacts): Readonly<V2RenderablePlanSnapshotFacts> {
  serializeOutputCanonicalJson(input)
  forkExact(input, ['id', 'workspaceId', 'projectId', 'projectVersionId', 'planId', 'origin',
    'sourceId', 'sourceHash', 'sourceVersion', 'fps', 'durationFrames', 'clipCount', 'planJson', 'planHash', 'createdAt'])
  assertDomain([input.workspaceId, input.projectId, input.projectVersionId].every((id) => typeof id === 'string' && ID_PATTERN.test(id)) &&
    isForkIdentityV2('renderable-snapshot', input.id) && isForkIdentityV2('renderable-plan', input.planId) &&
    ['react-playback', 'multi-range-synthesis', 'music-led-montage', 'localization'].includes(input.origin) &&
    typeof input.sourceId === 'string' && input.sourceId.trim() === input.sourceId && input.sourceId.length > 0 && input.sourceId.length <= 160 &&
    HASH_PATTERN.test(input.sourceHash) && HASH_PATTERN.test(input.planHash) &&
    (input.sourceVersion === null || Number.isSafeInteger(input.sourceVersion) && input.sourceVersion >= 0) &&
    typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt)) &&
    new Date(input.createdAt).toISOString() === input.createdAt,
  'INVALID_COMMAND', 'Renderable snapshot facts identity/source/time mismatch')
  let parsed: unknown
  try { parsed = JSON.parse(input.planJson) } catch { assertDomain(false, 'INVALID_COMMAND', 'Renderable snapshot facts JSON is invalid') }
  assertDomain(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'INVALID_COMMAND', 'Renderable snapshot facts require the actual plan')
  serializeOutputCanonicalJson(parsed)
  const plan = validateDirectedEditPlan(parsed as DirectedEditPlan)
  const clips = plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  assertDomain(plan.id === input.planId && plan.projectVersionId === input.projectVersionId &&
    plan.fps === input.fps && plan.durationFrames === input.durationFrames && clips.length === input.clipCount &&
    calculateRenderablePlanHash(plan) === input.planHash && Array.isArray(plan.lineageRefs) &&
    plan.lineageRefs.includes(input.origin + ':' + input.sourceId + ':' + input.sourceHash),
  'INVALID_COMMAND', 'Renderable snapshot facts plan/measurements/historical hash mismatch')
  return Object.freeze({ ...input })
}
export function isForkIdentityV2(kind: ForkIdentityKindV2, value: unknown): value is string {
  return typeof value === 'string' && (kind === 'renderable-plan' || kind === 'renderable-snapshot'
    ? /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value) : ID_PATTERN.test(value))
}

/** Linear exact-member bijection. Source identities and target identities never
 * acquire authority through cardinality alone. Returned index is transient. */
export function indexForkIdentityBijectionV2(
  owned: readonly Readonly<{ kind: ForkIdentityKindV2; id: string }>[],
  mappings: readonly Readonly<ForkIdentityRemapV2>[],
): ReadonlyMap<string, string> {
  const expected = new Set<string>(), sourceIds = new Set<string>()
  for (const item of owned) {
    forkExact(item, ['kind', 'id'])
    assertDomain(FORK_IDENTITY_KINDS_V2.includes(item.kind) && isForkIdentityV2(item.kind, item.id),
      'INVALID_COMMAND', 'Fork source member is invalid')
    const key = item.kind + ':' + item.id
    assertDomain(!expected.has(key), 'INVALID_COMMAND', 'Fork source repeats a member')
    expected.add(key); sourceIds.add(item.id)
  }
  assertDomain(mappings.length === expected.size, 'INVALID_COMMAND', 'Fork map omits or adds owned members')
  const index = new Map<string, string>(), targetIds = new Set<string>()
  for (const mapping of mappings) {
    forkExact(mapping, ['kind', 'sourceId', 'targetId'])
    const key = mapping.kind + ':' + mapping.sourceId
    assertDomain(expected.has(key) && !index.has(key) && isForkIdentityV2(mapping.kind, mapping.targetId) &&
      !targetIds.has(mapping.targetId) && !sourceIds.has(mapping.targetId),
    'INVALID_COMMAND', 'Fork map substitutes, repeats or shares an owned identity')
    index.set(key, mapping.targetId); targetIds.add(mapping.targetId)
  }
  return index
}

function object(value: unknown): Record<string, unknown> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_COMMAND', 'Fork requires an explicit source object')
  return value as Record<string, unknown>
}
function exact(value: unknown, keys: readonly string[]): void { forkExact(value, keys) }
function same(left: unknown, right: unknown): boolean { return calculateOutputCanonicalHash(left) === calculateOutputCanonicalHash(right) }

export function validateForkSourceBundle(bundle: Readonly<OutputVersionBundle>): void {
  assertDomain(bundle.version.outputContractVersion === 1, 'INVALID_PROJECT_VERSION', 'Origin base must be operational contract one')
  validateOutputCanonicalPolicy(bundle.version)
  const state = createProjectOutputState(bundle.state.document, bundle.facts)
  assertDomain(state.stateHash === bundle.state.stateHash, 'INVALID_PROJECT_VERSION', 'Origin base State seal mismatch')
  const version = rebuildRetiredContractOneVersion({ ...bundle.version, outputState: state, previousBaseHash: bundle.previousBaseHash })
  assertDomain(same(version, bundle.version), 'INVALID_PROJECT_VERSION', 'Origin base Version mismatch')
  assertDomain(bundle.outputBaseHashJson === serializeOutputCanonicalJson(outputBoundVersionHashBody({
    workspaceId: version.workspaceId, projectId: version.projectId, resultVersionId: version.id,
    parentVersionId: state.document.parentVersionId, previousBaseHash: bundle.previousBaseHash,
    producerHash: state.document.producer.hash, outputStateId: state.document.id, outputStateHash: state.stateHash })),
  'INVALID_PROJECT_VERSION', 'Origin base authority text mismatch')
  exact(bundle.nonOutputSnapshotFacts, ['brief', 'policies', 'treatment', 'story'])
  assertDomain(typeof version.snapshotRefs.brief === 'string', 'INVALID_PROJECT_VERSION', 'Origin base requires an explicit brief')
  for (const kind of ['brief', 'policies', 'treatment', 'story'] as const) {
    const ref = version.snapshotRefs[kind], snapshot = bundle.nonOutputSnapshotFacts[kind]
    assertDomain(ref === undefined ? snapshot === null : snapshot !== null && snapshot.schemaVersion === 1 && snapshot.id === ref &&
      snapshot.workspaceId === version.workspaceId && snapshot.projectId === version.projectId && snapshot.kind === kind,
    'INVALID_PROJECT_VERSION', 'Origin snapshot scope and presence mismatch')
    if (snapshot) {
      const fresh = createProjectSnapshot(snapshot), document = JSON.parse(fresh.contentJson)
      assertDomain(fresh.contentJson === stableSerialize(document) && fresh.contentHash === calculateCanonicalHash(document) &&
        fresh.contentHash === createHash('sha256').update(fresh.contentJson, 'utf8').digest('hex'),
      'INVALID_PROJECT_VERSION', 'Origin snapshot authority mismatch')
    }
  }
  if (state.document.provenance.kind === 'creation-command') assertDomain(same(state.document.producer.document, {
    canonicalPolicyVersion: state.document.canonicalPolicyVersion, schemaVersion: 'project-created-version/v1',
    briefHash: bundle.nonOutputSnapshotFacts.brief.contentHash, policyHash: bundle.nonOutputSnapshotFacts.policies.contentHash }),
  'INVALID_PROJECT_VERSION', 'Origin root producer requires its actual snapshot facts')
}

export function validateForkRenderableFacts(source: Readonly<OutputVersionBundle>,
  snapshot: Readonly<V2RenderablePlanSnapshotFacts> | null): Readonly<V2RenderablePlanSnapshotFacts> | null {
  const anchor = source.state.document.renderablePlan
  assertDomain(anchor === null ? snapshot === null && source.facts.renderablePlanDocument === null
    : snapshot !== null && source.facts.renderablePlanDocument !== null,
  'INVALID_COMMAND', 'Fork requires explicit compiled snapshot presence')
  if (!anchor || !snapshot) return null
  const row = createV2RenderablePlanSnapshotFacts(snapshot)
  assertDomain(row.id === anchor.snapshotId && row.planHash === anchor.hash && row.workspaceId === source.version.workspaceId &&
    row.projectId === source.version.projectId && row.projectVersionId === source.version.id &&
    same(JSON.parse(row.planJson), source.facts.renderablePlanDocument),
  'INVALID_COMMAND', 'Fork compiled snapshot differs from actual State/Version/plan facts')
  return row
}
export function forkOwnedIdentities(source: Readonly<OutputVersionBundle>,
  renderableSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null = null): readonly Readonly<{ kind: ForkIdentityKindV2; id: string }>[] {
  validateForkSourceBundle(source)
  const result: { kind: ForkIdentityKindV2; id: string }[] = []
  const seen = new Set<string>()
  const add = (kind: ForkIdentityKindV2, id: unknown) => {
    assertDomain(isForkIdentityV2(kind, id), 'INVALID_COMMAND', 'Fork source identity is invalid')
    const key = kind + ':' + id
    if (!seen.has(key)) { seen.add(key); result.push({ kind, id }) }
  }
  add('version', source.version.id); add('state', source.state.document.id)
  for (const id of Object.values(source.version.snapshotRefs)) add('snapshot', id)
  const compiled = validateForkRenderableFacts(source, renderableSnapshot)
  if (compiled) add('renderable-snapshot', compiled.id)
  for (const entry of source.state.document.entries) { add('variant', entry.variantId); add('revision', entry.outputSpecRevisionId) }
  for (const overlay of source.state.document.overlays) add('overlay', overlay.id)
  for (const issue of source.state.document.invalidations) add('invalidation', issue.id)
  for (const [kind, document] of [['edit-plan', source.facts.editPlanDocument], ['renderable-plan', source.facts.renderablePlanDocument]] as const) {
    if (document === null) continue
    const plan = object(document); add(kind, plan.id)
    const planMembers = new Set<string>()
    const addPlanMember = (kind: ForkIdentityKindV2, id: unknown) => {
      assertDomain(isForkIdentityV2(kind, id), 'INVALID_COMMAND', 'Fork plan identity is invalid')
      const key = kind + ':' + id
      assertDomain(!planMembers.has(key), 'INVALID_COMMAND', 'Fork source plan repeats an owned identity')
      planMembers.add(key); add(kind, id)
    }
    for (const [collection, identityKind] of [['sources', 'plan-source'], ['videoTracks', 'track'], ['subtitleTracks', 'track'],
      ['audioTracks', 'track'], ['overlayTracks', 'track'], ['effectTracks', 'track'], ['markers', 'marker'],
      ['protectedElements', 'protected-element'], ['transitions', 'transition']] as const) {
      if (plan[collection] === undefined) continue
      assertDomain(Array.isArray(plan[collection]), 'INVALID_COMMAND', 'Fork plan collection must be explicit')
      for (const value of plan[collection] as unknown[]) {
        const item = object(value); if (item.id !== undefined) addPlanMember(identityKind, item.id)
        // Only these contract containers own child IDs. External metadata with
        // clips/cues-shaped fields is preserved without inventing ownership.
        const childrenOwned = collection === 'videoTracks' ? [['clips', 'clip']] as const
          : collection === 'subtitleTracks' ? [['cues', 'cue']] as const : []
        for (const [children, childKind] of childrenOwned) {
          if (item[children] === undefined) continue
          assertDomain(Array.isArray(item[children]), 'INVALID_COMMAND', 'Fork plan members must be explicit')
          for (const child of item[children] as unknown[]) addPlanMember(childKind, object(child).id)
        }
      }
    }
  }
  return Object.freeze(result.map((item) => Object.freeze(item)))
}

export function validateForkCropDecisions(source: Readonly<OutputVersionBundle>, decisions: readonly Readonly<ForkCropDecisionDraft>[],
  index: ReadonlyMap<string, string>, audit: Readonly<ApiAccessAuditContext>, createdAt: string): void {
  const overlays = new Map(source.state.document.overlays.map((overlay) => [overlay.id, overlay]))
  const seen = new Set<string>()
  assertDomain(decisions.length === overlays.size, 'INVALID_COMMAND', 'Every source overlay requires one new target decision')
  for (const decision of decisions) {
    exact(decision, ['sourceOverlayId', 'sourceOverlayHash', 'newOverlayId', 'newVariantId', 'newClipId', 'copiedDocument', 'author', 'createdAt', 'geometryStatus'])
    const original = overlays.get(decision.sourceOverlayId)
    assertDomain(original !== undefined && !seen.has(decision.sourceOverlayId),
      'INVALID_COMMAND', 'Fork crop decision omits, repeats or substitutes an overlay')
    seen.add(decision.sourceOverlayId)
    assertDomain(decision.sourceOverlayHash === calculateOutputCanonicalHash(original) && same(decision.copiedDocument, original.document) &&
      decision.newOverlayId === index.get('overlay:' + original.id) && decision.newVariantId === index.get('variant:' + original.variantId) &&
      decision.newClipId === index.get('clip:' + original.clipId) && decision.author.type === 'api-client' &&
      decision.author.id === audit.clientId && decision.author.delegatedUserId === audit.delegatedUserId &&
      decision.createdAt === createdAt && decision.geometryStatus === 'requires-target-materialization',
    'INVALID_COMMAND', 'Fork crop intent needs new identity, audit and exact source lineage')
  }
}


export const PROJECT_FORK_COMPILE_POLICY_VERSION = 'project-fork-typed-remap/2026-10-12-v1' as const
export interface ProjectForkDerivationBody extends OutputCanonicalPolicy {
  schemaVersion: 'project-fork-derivation/v1'
  id: string
  callerIntent: Readonly<{ schemaVersion: 'project-creation-intent/v2'; kind: 'fork-with-content'; name: string }>
  audit: Readonly<ApiAccessAuditContext>
  target: Readonly<OutputOriginAllocation & { commandId: string }>
  source: Readonly<OutputVersionBundle>
  sourceRenderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null
  identityMap: readonly Readonly<ForkIdentityRemapV2>[]
  cropDecisions: readonly Readonly<ForkCropDecisionDraft>[]
  compilePolicyVersion: typeof PROJECT_FORK_COMPILE_POLICY_VERSION
}
export interface ProjectForkDerivation {
  schemaVersion: 'project-fork-derivation/v1'
  document: Readonly<ProjectForkDerivationBody>
  derivationHash: string
}
/** Pre-allocation authority, isolated from persistence. It contains no target
 * plan hash, Command hash or resulting State/base hash. Source seals are actual
 * existing domain facts and must be confronted with PG at the future cutover. */
export function createProjectForkDerivation(
  input: Readonly<ProjectForkDerivationBody>,
): Readonly<ProjectForkDerivation> {
  forkExact(input, ['canonicalPolicyVersion', 'schemaVersion', 'id', 'callerIntent', 'audit',
    'target', 'source', 'sourceRenderablePlanSnapshot', 'identityMap', 'cropDecisions', 'compilePolicyVersion'])
  validateOutputCanonicalPolicy(input)
  serializeOutputCanonicalJson(input)
  assertDomain(input.schemaVersion === 'project-fork-derivation/v1' && ID_PATTERN.test(input.id) &&
    input.compilePolicyVersion === PROJECT_FORK_COMPILE_POLICY_VERSION,
  'INVALID_COMMAND', 'Fork derivation schema, identity or compile policy is invalid')
  forkExact(input.callerIntent, ['schemaVersion', 'kind', 'name'])
  assertDomain(input.callerIntent.schemaVersion === 'project-creation-intent/v2' &&
    input.callerIntent.kind === 'fork-with-content' &&
    typeof input.callerIntent.name === 'string' && input.callerIntent.name.length >= 1 && input.callerIntent.name.length <= 120 &&
    normalizeProjectName(input.callerIntent.name) === input.callerIntent.name,
  'INVALID_COMMAND', 'Fork derivation requires the exact normalized caller intent')
  const audit = createApiAccessAuditContext(input.audit), a = input.target
  forkExact(a, ['commandId', 'workspaceId', 'projectId', 'resultVersionId', 'stateId',
    'parentVersionId', 'sequence', 'createdBy', 'createdAt'])
  assertDomain(audit.contextHash === input.audit.contextHash && audit.workspaceId === a.workspaceId &&
    a.createdBy === audit.clientId, 'AUTH_INVALID', 'Fork derivation actor differs from target allocation')
  assertDomain([a.commandId, a.workspaceId, a.projectId, a.resultVersionId, a.stateId].every((id) => ID_PATTERN.test(id)) &&
    a.parentVersionId === null && a.sequence === 1 &&
    new Set([a.commandId, a.projectId, a.resultVersionId, a.stateId]).size === 4 &&
    Number.isFinite(Date.parse(a.createdAt)) && new Date(a.createdAt).toISOString() === a.createdAt,
  'INVALID_COMMAND', 'Fork derivation requires fresh root identities and canonical time')
  forkExact(input.source, ['version', 'state', 'facts', 'nonOutputSnapshotFacts', 'previousBaseHash', 'editCommandSeal', 'outputBaseHashJson'])
  validateForkSourceBundle(input.source)
  assertDomain(input.source.version.workspaceId === a.workspaceId && input.source.version.projectId !== a.projectId,
    'INVALID_COMMAND', 'Fork derivation source scope is not independent')
  const compiled = validateForkRenderableFacts(input.source, input.sourceRenderablePlanSnapshot)
  assertDomain(Array.isArray(input.identityMap) && input.identityMap.length <= 100_000 && Array.isArray(input.cropDecisions),
    'INVALID_COMMAND', 'Fork derivation requires bounded explicit identity and decision arrays')
  const members = forkOwnedIdentities(input.source, compiled)
  const index = indexForkIdentityBijectionV2(members, input.identityMap)
  const excluded = new Set([input.id, a.commandId, a.workspaceId, a.projectId,
    input.source.version.workspaceId, input.source.version.projectId])
  assertDomain(!members.some((member) => member.id === input.id) &&
    ![a.commandId, a.workspaceId, a.projectId, a.resultVersionId, a.stateId].includes(input.id) &&
    [...index.values()].every((id) => !excluded.has(id)) &&
    index.get('version:' + input.source.version.id) === a.resultVersionId &&
    index.get('state:' + input.source.state.document.id) === a.stateId,
  'INVALID_COMMAND', 'Fork derivation allocations or exact bijection are inconsistent')
  validateForkCropDecisions(input.source, input.cropDecisions, index, audit, a.createdAt)
  const document = freezeOutputJson(input as unknown as OutputJson) as unknown as Readonly<ProjectForkDerivationBody>
  return Object.freeze({ schemaVersion: input.schemaVersion, document,
    derivationHash: calculateOutputCanonicalHash(document) })
}

export function validateProjectForkDerivation(input: Readonly<ProjectForkDerivation>): Readonly<ProjectForkDerivation> {
  forkExact(input, ['schemaVersion', 'document', 'derivationHash'])
  const fresh = createProjectForkDerivation(input.document)
  assertDomain(input.schemaVersion === fresh.schemaVersion && input.derivationHash === fresh.derivationHash,
    'INVALID_COMMAND', 'Fork derivation envelope or seal mismatch')
  return fresh
}

/** Container-specific projection. Unknown/external metadata is copied as data,
 * never walked for keys that happen to look like identity references. */
export function remapForkSnapshotDocument(document: unknown,
  kind: ProjectSnapshot['kind'] | 'renderable-plan', source: Readonly<OutputVersionBundle>,
  a: Readonly<OutputOriginAllocation>, map: readonly Readonly<ForkIdentityRemapV2>[],
  sourceRenderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null = null): unknown {
  const index = indexForkIdentityBijectionV2(forkOwnedIdentities(source, sourceRenderablePlanSnapshot), map)
  return remapForkDocumentWithIndex(document, kind, {
    version: source.version, editPlanDocument: source.facts.editPlanDocument,
    renderablePlanDocument: source.facts.renderablePlanDocument,
    nonOutputSnapshotFacts: source.nonOutputSnapshotFacts,
  }, a, index)
}

/** The projection operates on validated facts, not on a synthesized historical
 * bundle. Each source contract validates its own authority before calling it. */
function remapForkDocumentWithIndex(document: unknown,
  kind: ProjectSnapshot['kind'] | 'renderable-plan', source: Readonly<{
    version: Readonly<{ id: string; projectId: string }>
    editPlanDocument: unknown; renderablePlanDocument: unknown
    nonOutputSnapshotFacts: Readonly<Record<'brief' | 'policies' | 'treatment' | 'story', ProjectSnapshot | null>>
  }>, a: Readonly<OutputOriginAllocation>, index: ReadonlyMap<string, string>, currentSource = false): unknown {
  const target = (memberKind: ForkIdentityKindV2, id: unknown) => {
    assertDomain(typeof id === 'string', 'INVALID_COMMAND', 'Fork reference requires an identity')
    const mapped = index.get(memberKind + ':' + id)
    assertDomain(mapped !== undefined, 'INVALID_COMMAND', 'Fork reference requires an exact map member')
    return mapped
  }
  serializeOutputCanonicalJson(document)
  assertDomain(['brief', 'policies', 'treatment', 'story', 'edit-plan', 'renderable-plan'].includes(kind),
    'INVALID_COMMAND', 'Fork does not transfer perception, critic or approval snapshots')
  const original = object(document)
  const actual = kind === 'edit-plan' ? source.editPlanDocument : kind === 'renderable-plan'
    ? source.renderablePlanDocument : source.nonOutputSnapshotFacts[kind as 'brief' | 'policies' | 'treatment' | 'story']
  const actualDocument = kind === 'edit-plan' || kind === 'renderable-plan' ? actual
    : actual === null ? null : JSON.parse((actual as ProjectSnapshot).contentJson)
  assertDomain(actualDocument !== null && same(document, actualDocument), 'INVALID_COMMAND', 'Fork remapper requires its actual source document')
  assertDomain(currentSource || !['reviewStatus', 'forkDerivationRef', 'sourceDirectionLineage', 'sourceEditingLineage']
    .some((key) => Object.hasOwn(original, key)), 'INVALID_COMMAND', 'Fork cannot transfer a prior acceptance or fork authority')
  if (kind !== 'edit-plan' && kind !== 'renderable-plan') {
    return JSON.parse(rebindSnapshotContentForDuplicate({ kind,
      contentJson: stableSerialize(original), contentHash: calculateCanonicalHash(original),
      source: { projectId: source.version.projectId, versionId: source.version.id },
      copy: { projectId: a.projectId, versionId: a.resultVersionId } }).contentJson)
  }
  const references = (value: unknown, memberKind: ForkIdentityKindV2,
    fields: readonly (readonly [string, ForkIdentityKindV2])[] = []) => {
    const old = object(value), next = { ...old }
    if (old.id !== undefined) next.id = target(memberKind, old.id)
    for (const [key, refKind] of fields) if (old[key] !== undefined) next[key] = target(refKind, old[key])
    return next
  }
  const collection = (value: unknown, project: (value: unknown) => unknown) => {
    assertDomain(Array.isArray(value), 'INVALID_COMMAND', 'Fork plan container must be an explicit array')
    return value.map(project)
  }
  assertDomain(original.localeVariantRefs === undefined || Array.isArray(original.localeVariantRefs) && original.localeVariantRefs.length === 0,
    'INVALID_COMMAND', 'Fork locale variant relationships require a distinct typed materialization')
  const next: Record<string, unknown> = { ...original, id: target(kind === 'renderable-plan' ? 'renderable-plan' : 'edit-plan', original.id),
    projectVersionId: a.resultVersionId, createdAt: currentSource ? original.createdAt : a.createdAt }
  if (original.projectId !== undefined) next.projectId = a.projectId
  if (original.workspaceId !== undefined) next.workspaceId = a.workspaceId
  if (currentSource) {
    // Prior fork/evaluation data remains in the immutable source receipt. It
    // never becomes target execution or approval authority through copying.
    for (const key of ['reviewStatus', 'forkDerivationRef', 'sourceDirectionLineage', 'sourceEditingLineage']) delete next[key]
  }
  next.sources = collection(original.sources, (item) => references(item, 'plan-source'))
  next.videoTracks = collection(original.videoTracks, (value) => {
    const track = references(value, 'track'), old = object(value)
    track.clips = collection(old.clips, (clip) => references(clip, 'clip', [['sourceId', 'plan-source'], ['trackId', 'track']]))
    return track
  })
  next.subtitleTracks = collection(original.subtitleTracks, (value) => {
    const track = references(value, 'track'), old = object(value)
    track.cues = collection(old.cues, (cue) => references(cue, 'cue', [['clipId', 'clip'], ['trackId', 'track']]))
    return track
  })
  // Current domain audio tracks are pinned background music records. Their
  // artifact, analysis and rights identities are external media facts.
  next.audioTracks = collection(original.audioTracks, (value) => {
    const track = references(value, 'track')
    assertDomain(track.kind === 'background-music', 'INVALID_COMMAND', 'Fork audio container requires its typed materialization')
    return track
  })
  next.overlayTracks = collection(original.overlayTracks, (value) =>
    references(value, 'track', [['clipId', 'clip'], ['variantId', 'variant']]))
  next.effectTracks = collection(original.effectTracks, (value) =>
    references(value, 'track', [['clipId', 'clip'], ['trackId', 'track']]))
  for (const [key, memberKind, fields] of [
    ['markers', 'marker', [['clipId', 'clip']]],
    ['protectedElements', 'protected-element', [['clipId', 'clip'], ['cueId', 'cue'], ['trackId', 'track']]],
    ['transitions', 'transition', [['fromClipId', 'clip'], ['toClipId', 'clip']]],
  ] as const) if (original[key] !== undefined) next[key] = collection(original[key], (value) => references(value, memberKind, fields))
  if (original.formatVariantRefs !== undefined) {
    next.formatVariantRefs = collection(original.formatVariantRefs, (id) => target('variant', id))
  }
  // Snapshot-backed aggregate refs are reminted only when the actual source
  // owns that snapshot. Compiler-private handles stay source lineage for now.
  for (const key of ['storyPlanId', 'treatmentPlanId']) if (typeof original[key] === 'string' && index.has('snapshot:' + original[key])) {
    next[key] = target('snapshot', original[key])
  }
  // Prior evaluation is retained by the immutable source document, not copied
  // into a target plan. No target acceptance or critic is created here.
  for (const key of ['critic', 'qualityReport', 'quality', 'qualityScore', 'acceptance', 'approval', 'proxyReview']) delete next[key]
  if (kind === 'renderable-plan') {
    const plan = next as unknown as DirectedEditPlan
    const clips = plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
    next.audioTimelineHash = createDirectedAudioTimelineHash({ fps: plan.fps, clips, musicTracks: plan.audioTracks })
  }
  return next
}


export interface ForkDerivationReference extends OutputCanonicalPolicy {
  schemaVersion: 'project-fork-derivation-ref/v1'
  id: string
  hash: string
  compilePolicyVersion: typeof PROJECT_FORK_COMPILE_POLICY_VERSION
}
/** A fork kernel is not another Director's plan. Source aggregate handles and
 * planning decisions are retained only in the explicit source-lineage section. */
export type ForkRenderablePlan = Readonly<Omit<DirectedEditPlan,
  'directorRunId' | 'storyPlanId' | 'treatmentPlanId' | 'director'> & {
  forkDerivationRef: Readonly<ForkDerivationReference>
  sourceDirectionLineage: Readonly<{
    snapshotId: string; planId: string; planHash: string
    origin: V2RenderablePlanSnapshotFacts['origin']; sourceId: string; sourceHash: string; sourceVersion: number | null
    directorRunId: string; storyPlanId: string; treatmentPlanId: string; director: DirectedEditPlan['director']
  }>
  reviewStatus: 'requires-target-materialization'
}>
export interface ForkRenderablePlanCandidate extends OutputCanonicalPolicy {
  schemaVersion: 'project-fork-renderable-candidate/v1'
  id: string; workspaceId: string; projectId: string; projectVersionId: string; planId: string
  derivationRef: Readonly<ForkDerivationReference>
  fps: number; durationFrames: number; clipCount: number
  planJson: string; planHash: string; createdAt: string
}
export function forkRenderablePlanHash(plan: Readonly<ForkRenderablePlan>): string {
  return calculateOutputCanonicalHash({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'project-fork-renderable-plan-hash/v1', compilePolicyVersion: PROJECT_FORK_COMPILE_POLICY_VERSION, plan })
}
export function materializeForkRenderablePlan(
  derivation: Readonly<ProjectForkDerivation>,
): Readonly<ForkRenderablePlan> {
  const fresh = validateProjectForkDerivation(derivation)
  const d = fresh.document, source = d.source, row = d.sourceRenderablePlanSnapshot
  assertDomain(row !== null, 'INVALID_COMMAND', 'Fork kernel requires the actual compiled source row')
  const original = validateDirectedEditPlan(JSON.parse(row.planJson) as DirectedEditPlan)
  const mapped = remapForkSnapshotDocument(original, 'renderable-plan', source, d.target, d.identityMap, row) as DirectedEditPlan
  const kernel: Record<string, unknown> = { ...mapped }
  delete kernel.directorRunId; delete kernel.storyPlanId; delete kernel.treatmentPlanId; delete kernel.director; delete kernel.manualEditing
  const plan: ForkRenderablePlan = {
    ...(kernel as unknown as Omit<DirectedEditPlan, 'directorRunId' | 'storyPlanId' | 'treatmentPlanId' | 'director'>),
    forkDerivationRef: { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
      schemaVersion: 'project-fork-derivation-ref/v1', id: d.id, hash: fresh.derivationHash,
      compilePolicyVersion: d.compilePolicyVersion },
    sourceDirectionLineage: { snapshotId: row.id, planId: row.planId, planHash: row.planHash,
      origin: row.origin, sourceId: row.sourceId, sourceHash: row.sourceHash, sourceVersion: row.sourceVersion,
      directorRunId: original.directorRunId, storyPlanId: original.storyPlanId,
      treatmentPlanId: original.treatmentPlanId, director: original.director },
    reviewStatus: 'requires-target-materialization',
  }
  return freezeOutputJson(plan as unknown as OutputJson) as unknown as Readonly<ForkRenderablePlan>
}
export function createForkRenderablePlanCandidate(
  input: Readonly<ForkRenderablePlanCandidate>, derivation: Readonly<ProjectForkDerivation>,
): Readonly<ForkRenderablePlanCandidate> {
  forkExact(input, ['schemaVersion', 'canonicalPolicyVersion', 'id', 'workspaceId', 'projectId',
    'projectVersionId', 'planId', 'derivationRef', 'fps', 'durationFrames', 'clipCount', 'planJson', 'planHash', 'createdAt'])
  validateOutputCanonicalPolicy(input)
  serializeOutputCanonicalJson(input)
  const plan = materializeForkRenderablePlan(derivation), d = derivation.document
  let parsed: unknown
  try { parsed = JSON.parse(input.planJson) } catch { assertDomain(false, 'INVALID_COMMAND', 'Fork candidate JSON is invalid') }
  const candidate = object(parsed)
  // Reuse the real geometry/audio/action validator on the kernel projection.
  // These source handles are only validation data, never target provenance.
  const sourcePlan = validateDirectedEditPlan(JSON.parse(d.sourceRenderablePlanSnapshot!.planJson) as DirectedEditPlan)
  validateDirectedEditPlan({ ...candidate, directorRunId: sourcePlan.directorRunId,
    storyPlanId: sourcePlan.storyPlanId, treatmentPlanId: sourcePlan.treatmentPlanId,
    director: sourcePlan.director } as unknown as DirectedEditPlan)
  const index = indexForkIdentityBijectionV2(forkOwnedIdentities(d.source, d.sourceRenderablePlanSnapshot), d.identityMap)
  assertDomain(input.schemaVersion === 'project-fork-renderable-candidate/v1' &&
    input.id === index.get('renderable-snapshot:' + d.sourceRenderablePlanSnapshot!.id) &&
    input.workspaceId === d.target.workspaceId && input.projectId === d.target.projectId &&
    input.projectVersionId === d.target.resultVersionId && input.planId === plan.id && input.createdAt === d.target.createdAt &&
    same(input.derivationRef, plan.forkDerivationRef) && input.fps === plan.fps &&
    input.durationFrames === plan.durationFrames &&
    input.clipCount === plan.videoTracks.reduce((count, track) => count + track.clips.length, 0) &&
    input.planJson === serializeOutputCanonicalJson(plan) && input.planHash === forkRenderablePlanHash(plan),
  'INVALID_COMMAND', 'Fork candidate differs from its exact derivation, source content or identity map')
  return freezeOutputJson(input as unknown as OutputJson) as unknown as Readonly<ForkRenderablePlanCandidate>
}

/** Source facts only; this projection creates no target snapshot authority. */
export function forkSourceSnapshotFacts(source: Readonly<OutputVersionBundle>): readonly Readonly<ProjectSnapshot>[] {
  validateForkSourceBundle(source)
  const snapshots = [source.nonOutputSnapshotFacts.brief, source.nonOutputSnapshotFacts.policies,
    source.nonOutputSnapshotFacts.treatment, source.nonOutputSnapshotFacts.story]
    .filter((snapshot): snapshot is Readonly<ProjectSnapshot> => snapshot !== null)
  snapshots.push({ schemaVersion: 1, id: source.state.document.editPlan.snapshotId,
    workspaceId: source.version.workspaceId, projectId: source.version.projectId, kind: 'edit-plan',
    contentSchemaVersion: Number(object(source.facts.editPlanDocument).schemaVersion),
    contentJson: stableSerialize(source.facts.editPlanDocument), contentHash: source.state.document.editPlan.hash,
    createdAt: source.version.createdAt })
  return Object.freeze(snapshots)
}

export type ForkSourceManualEditing = Readonly<
  { schemaVersion: 1; action: 'apply'; operation: Readonly<ManualGesture>; variantId: string } |
  { schemaVersion: 1; action: 'undo' | 'redo' | 'restore'; restoresVersionId: string; variantId: string }
>
/** A historical manual operation remains source lineage. It is not reminted as
 * if a target Command had applied it or restored an ancestor. */
export function materializeForkEditPlan(derivation: Readonly<ProjectForkDerivation>): Readonly<Record<string, unknown>> {
  const fresh = validateProjectForkDerivation(derivation)
  const d = fresh.document, original = object(d.source.facts.editPlanDocument)
  const mapped = object(remapForkSnapshotDocument(original, 'edit-plan', d.source, d.target, d.identityMap, d.sourceRenderablePlanSnapshot))
  delete mapped.manualEditing
  if (original.directorRunId !== undefined) {
    const direction = validateDirectedEditPlan(original as unknown as DirectedEditPlan)
    delete mapped.directorRunId; delete mapped.storyPlanId; delete mapped.treatmentPlanId; delete mapped.director
    mapped.sourceDirectionLineage = { snapshotId: d.source.state.document.editPlan.snapshotId, planId: direction.id,
      planHash: d.source.state.document.editPlan.hash, directorRunId: direction.directorRunId, storyPlanId: direction.storyPlanId,
      treatmentPlanId: direction.treatmentPlanId, director: direction.director }
  }
  mapped.forkDerivationRef = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, schemaVersion: 'project-fork-derivation-ref/v1',
    id: d.id, hash: fresh.derivationHash, compilePolicyVersion: d.compilePolicyVersion }
  if (original.manualEditing !== undefined) {
    const manual = object(original.manualEditing)
    forkExact(manual, manual.action === 'apply' ? ['schemaVersion', 'action', 'operation', 'variantId']
      : ['schemaVersion', 'action', 'restoresVersionId', 'variantId'])
    assertDomain(manual.schemaVersion === 1 && ['apply', 'undo', 'redo', 'restore'].includes(String(manual.action)) &&
      typeof manual.variantId === 'string', 'INVALID_COMMAND', 'Fork source manual history is not its real typed record')
    if (manual.action === 'apply') {
      const operation = object(manual.operation)
      assertDomain(['select', 'trim', 'split', 'move', 'replace', 'crop', 'inspect'].includes(String(operation.kind)),
        'INVALID_COMMAND', 'Fork source manual operation kind is unsupported')
      validateManualGesture(operation as unknown as ManualGesture)
    } else assertDomain(typeof manual.restoresVersionId === 'string' && ID_PATTERN.test(manual.restoresVersionId),
      'INVALID_COMMAND', 'Fork source restore lineage requires its actual historical target')
    mapped.sourceEditingLineage = { sourceVersionId: d.source.version.id, sourcePlanId: original.id,
      sourcePlanHash: d.source.state.document.editPlan.hash, manualEditing: manual as unknown as ForkSourceManualEditing }
  }
  return freezeOutputJson(mapped as unknown as OutputJson) as unknown as Readonly<Record<string, unknown>>
}

/** Persisted fork authority, distinct from the historical isolated v1 kernel.
 * The EditPlan row is supplied as an actual row: snapshot reuse need not share
 * the Version creation timestamp. All source rows remain source-scoped. */

export interface ForkProtectedPayloadMetadataV2 {
  ref: string; workspaceId: string; canonicalByteSize: number; algorithm: string; keyId: string
  nonce: string; ciphertextSha256: string; ciphertextByteSize: number; authTag: string; createdAt: string
}
export interface ForkManifestRowFactsV2 {
  id: string; artifactId: string; workspaceId: string; schemaVersion: string; manifestJson: string; manifestHash: string; createdAt: string
  recipeId: string; recipeVersion: string; parametersHash: string; recipeParametersRef: string | null
  renderInputRef: string | null; renderInputHash: string | null
  recipeParameters: Readonly<ForkProtectedPayloadMetadataV2 & { parametersHash: string }> | null
  renderInput: Readonly<ForkProtectedPayloadMetadataV2 & { inputHash: string }> | null
}
function validateForkProtectedMetadataV2(value: ForkProtectedPayloadMetadataV2 & { parametersHash?: string; inputHash?: string },
  workspaceId: string, ref: string, hash: string, kind: 'recipe-parameters' | 'render-input'): void {
  forkExact(value, ['ref','workspaceId','canonicalByteSize','algorithm','keyId','nonce','ciphertextSha256','ciphertextByteSize','authTag','createdAt',
    kind === 'recipe-parameters' ? 'parametersHash' : 'inputHash'])
  assertDomain(value.workspaceId === workspaceId && value.ref === ref && ref === kind+'/sha256/'+hash &&
    (kind === 'recipe-parameters' ? value.parametersHash : value.inputHash) === hash &&
    Number.isSafeInteger(value.canonicalByteSize) && value.canonicalByteSize > 0 && value.canonicalByteSize <= (kind === 'recipe-parameters' ? 1024*1024 : 4*1024*1024) &&
    value.algorithm === 'aes-256-gcm' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.keyId) && /^[A-Za-z0-9_-]{16}$/.test(value.nonce) &&
    /^[A-Za-z0-9_-]{22}$/.test(value.authTag) && Number.isSafeInteger(value.ciphertextByteSize) && value.ciphertextByteSize > 0 &&
    /^[a-f0-9]{64}$/.test(value.ciphertextSha256) && new Date(value.createdAt).toISOString() === value.createdAt,
    'INVALID_COMMAND','Fork protected payload metadata scope/ref/hash mismatch')
}
export interface ForkMediaReferenceFactsV2 {
  sourceLinkId: string; targetLinkId: string; workspaceId: string; sourceProjectId: string
  artifactId: string; role: 'source-master' | 'source-audio' | 'source-image' | 'editing-proxy' | 'editorial-proxy' | 'final-output' | 'selected-insert'
  originalFileName: string; sourceLinkCreatedAt: string
  artifactKey: string; artifactSha256: string; artifactByteSize: string; artifactMediaType: string; artifactContainer: string
  artifactLifecycleRevision: number; purpose: 'editing' | 'editorial-reuse'
  manifestFacts: Readonly<ForkManifestRowFactsV2>
}
export interface ProjectForkDerivationBodyV2 extends OutputCanonicalPolicy {
  schemaVersion: 'project-fork-derivation/v2'
  id: string
  kernel: Readonly<ProjectForkDerivation>
  kernelCanonicalJson: string
  sourceEditPlanSnapshot: Readonly<ProjectSnapshot>
  sourceReferences: readonly Readonly<ForkMediaReferenceFactsV2>[]
  sourceProject: Readonly<{ id: string; workspaceId: string; currentVersionId: string; name: string; status: string; format: string | null; ownerId: string | null;
    administrationRevision: number; updatedAt: string; objective: string; locale: string | null;
    createdByType: string; createdById: string; createdAt: string }>
}
export interface ProjectForkDerivationV2 {
  schemaVersion: 'project-fork-derivation/v2'
  document: Readonly<ProjectForkDerivationBodyV2>
  derivationHash: string
}
export function createProjectForkDerivationV2(input: ProjectForkDerivationBodyV2): Readonly<ProjectForkDerivationV2> {
  forkExact(input, ['schemaVersion', 'canonicalPolicyVersion', 'id', 'kernel', 'sourceEditPlanSnapshot', 'sourceProject', 'sourceReferences', 'kernelCanonicalJson'])
  validateOutputCanonicalPolicy(input)
  assertDomain(input.schemaVersion === 'project-fork-derivation/v2', 'INVALID_COMMAND', 'Persisted fork derivation version mismatch')
  const kernel = validateProjectForkDerivation(input.kernel), source = kernel.document.source
  assertDomain(input.id === kernel.document.id && input.kernelCanonicalJson === serializeOutputCanonicalJson(kernel.document) &&
    createHash('sha256').update(input.kernelCanonicalJson,'utf8').digest('hex') === kernel.derivationHash, 'INVALID_COMMAND', 'Persisted fork derivation identity/kernel text seal mismatch')
  forkExact(input.sourceProject, ['id', 'workspaceId', 'currentVersionId', 'name', 'status', 'format', 'ownerId', 'administrationRevision', 'updatedAt', 'objective', 'locale', 'createdByType', 'createdById', 'createdAt'])
  const project = input.sourceProject
  assertDomain(project.id === source.version.projectId && project.workspaceId === source.version.workspaceId &&
    project.currentVersionId === source.version.id && typeof project.objective === 'string' && project.objective.length > 0 &&
    (project.locale === null || (typeof project.locale === 'string' && project.locale.length > 0)) && ['api-client', 'user', 'system', 'director'].includes(project.createdByType) &&
    typeof project.name === 'string' && project.name.length > 0 && typeof project.status === 'string' && project.status.length > 0 &&
    (project.format === null || typeof project.format === 'string') && (project.ownerId === null || typeof project.ownerId === 'string') &&
    Number.isSafeInteger(project.administrationRevision) && project.administrationRevision > 0 &&
    new Date(project.updatedAt).toISOString() === project.updatedAt &&
    typeof project.createdById === 'string' && project.createdById.length > 0 && new Date(project.createdAt).toISOString() === project.createdAt,
    'INVALID_COMMAND', 'Persisted fork requires its actual source Project row and head')
  forkExact(input.sourceEditPlanSnapshot, ['schemaVersion', 'id', 'workspaceId', 'projectId', 'kind', 'contentSchemaVersion', 'contentJson', 'contentHash', 'createdAt'])
  assertDomain(input.sourceEditPlanSnapshot.schemaVersion === 1, 'INVALID_COMMAND', 'Actual source EditPlan envelope version mismatch')
  const row = createProjectSnapshot(input.sourceEditPlanSnapshot)
  assertDomain(serializeOutputCanonicalJson(row) === serializeOutputCanonicalJson(input.sourceEditPlanSnapshot),
    'INVALID_COMMAND', 'Actual source EditPlan envelope cannot be normalized')
  assertDomain(row.schemaVersion === 1 && row.kind === 'edit-plan' &&
    row.id === source.version.snapshotRefs.editPlan && row.id === source.state.document.editPlan.snapshotId &&
    row.workspaceId === source.version.workspaceId && row.projectId === source.version.projectId &&
    row.contentSchemaVersion === Number((source.facts.editPlanDocument as unknown as { schemaVersion: unknown }).schemaVersion) &&
    row.contentHash === source.state.document.editPlan.hash &&
    row.contentJson === stableSerialize(source.facts.editPlanDocument) &&
    row.contentHash === createHash('sha256').update(row.contentJson, 'utf8').digest('hex') &&
    Number.isFinite(Date.parse(row.createdAt)) && new Date(row.createdAt).toISOString() === row.createdAt,
  'INVALID_COMMAND', 'Persisted fork requires its exact source EditPlan snapshot row')
  validateForkMediaReferenceFacts(input.sourceReferences, project, source)
  // Rights/consent are deliberately not copied. The repository evaluates the
  // exact declared intent purpose against each current artifact rights row.
  // Date is intentionally not reconstructed from source.version.createdAt.
  const document = freezeOutputJson({ ...input, kernel, sourceEditPlanSnapshot: row } as unknown as OutputJson) as unknown as Readonly<ProjectForkDerivationBodyV2>
  return Object.freeze({ schemaVersion: input.schemaVersion, document, derivationHash: calculateOutputCanonicalHash(document) })
}
export function validateProjectForkDerivationV2(input: ProjectForkDerivationV2): Readonly<ProjectForkDerivationV2> {
  forkExact(input, ['schemaVersion', 'document', 'derivationHash'])
  const fresh = createProjectForkDerivationV2(input.document)
  assertDomain(input.schemaVersion === fresh.schemaVersion && input.derivationHash === fresh.derivationHash,
    'INVALID_COMMAND', 'Persisted fork derivation seal mismatch')
  return fresh
}

export interface ForkDerivationReferenceV2 extends OutputCanonicalPolicy {
  schemaVersion: 'project-fork-derivation-ref/v2'
  id: string
  hash: string
  compilePolicyVersion: typeof PROJECT_FORK_COMPILE_POLICY_VERSION
}

/** A current source retains its actual Creation2/Operational3 receipt. The
 * projection below is a new, discriminated factual container; it is never an
 * OutputVersionBundle1 and cannot enter any historical constructor. */
export interface ProjectForkSourceV3 extends OutputCanonicalPolicy {
  schemaVersion: 'project-fork-source/v3'
  bundle: OperationalOutputParentV3
  bundleHash: string
  bundleCanonicalJson: string
  version: OperationalOutputParentV3['version']
  state: OperationalOutputParentV3['state']
  facts: Readonly<{ editPlanDocument: OutputJson; renderablePlanDocument: OutputJson | null }>
  nonOutputSnapshotFacts: Readonly<Record<'brief' | 'policies' | 'treatment' | 'story', ProjectSnapshot | null>>
  previousBaseHash: string | null
  outputBaseHashJson: string
}

export interface ProjectForkCallerRequestV3 extends OutputCanonicalPolicy {
  schemaVersion: 'project-duplication-request/v3'
  workspaceId: string; sourceProjectId: string; sourceVersionId: string; sourceVersionHash: string
  requestedName: string | null; actorContextHash: string
}
export function validateProjectForkCallerRequestV3(input: ProjectForkCallerRequestV3): Readonly<ProjectForkCallerRequestV3> {
  forkExact(input, ['schemaVersion', 'canonicalPolicyVersion', 'workspaceId', 'sourceProjectId', 'sourceVersionId',
    'sourceVersionHash', 'requestedName', 'actorContextHash'])
  validateOutputCanonicalPolicy(input)
  assertDomain(input.schemaVersion === 'project-duplication-request/v3' &&
    [input.workspaceId, input.sourceProjectId, input.sourceVersionId].every(id => typeof id === 'string' && ID_PATTERN.test(id)) &&
    HASH_PATTERN.test(input.sourceVersionHash) && HASH_PATTERN.test(input.actorContextHash) &&
    (input.requestedName === null || typeof input.requestedName === 'string' && normalizeProjectName(input.requestedName) === input.requestedName &&
      input.requestedName.length >= 1 && input.requestedName.length <= 120), 'INVALID_ARGUMENT', 'Fork3 caller request is invalid')
  return freezeOutputJson(input as unknown as OutputJson) as unknown as Readonly<ProjectForkCallerRequestV3>
}

// Constructor outputs only. Compiled source rows supplied separately may be
// mutable, so the source shortcut is restricted to the explicit null binding.
const validatedUncompiledForkSourcesV3 = new WeakSet<object>()
const validatedForkDerivationsV3 = new WeakSet<object>()
export function createProjectForkSourceV3(input: Readonly<{
  bundle: OperationalOutputParentV3; snapshots: readonly Readonly<ProjectSnapshot>[]
  renderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null
}>): Readonly<ProjectForkSourceV3> {
  forkExact(input, ['bundle', 'snapshots', 'renderablePlanSnapshot'])
  const bundle = input.bundle, v = bundle.version, s = bundle.state
  assertDomain(bundle.schemaVersion === 'project-creation-output-bundle/v2' && v.outputContractVersion === 2 ||
    bundle.schemaVersion === 'operational-output-version-bundle/v3' && v.outputContractVersion === 3,
  'INVALID_PROJECT_VERSION', 'Fork3 requires the actual source contract discriminator')
  const plan = operationalBundlePlanV3(bundle)
  if (bundle.schemaVersion === 'project-creation-output-bundle/v2') validateCreationOutputVersionBundleV2(bundle)
  const blockedCandidate = bundle.schemaVersion === 'project-creation-output-bundle/v2' ? bundle.command.payload.renderableCandidate : null
  const facts = { editPlanDocument: JSON.parse(plan.contentJson) as OutputJson,
    renderablePlanDocument: input.renderablePlanSnapshot !== null ? JSON.parse(input.renderablePlanSnapshot.planJson) as OutputJson
      : blockedCandidate !== null ? JSON.parse(blockedCandidate.planJson) as OutputJson : null }
  if (bundle.schemaVersion === 'operational-output-version-bundle/v3') {
    const state = createProjectOutputStateV3(bundle.state.document, facts)
    assertDomain(state.stateHash === bundle.state.stateHash, 'INVALID_PROJECT_VERSION', 'Fork3 source State seal differs')
  }
  assertDomain(v.outputStateId === s.document.id && v.outputStateHash === s.stateHash &&
    s.document.resultVersionId === v.id && s.document.workspaceId === v.workspaceId && s.document.projectId === v.projectId &&
    s.document.editPlan.snapshotId === plan.id && s.document.editPlan.hash === plan.contentHash &&
    calculateOutputCanonicalHash(s.document) === s.stateHash &&
    createHash('sha256').update(bundle.outputBaseHashJson, 'utf8').digest('hex') === v.baseHash,
  'INVALID_PROJECT_VERSION', 'Fork3 source receipt bindings differ')
  const hashBody = object(JSON.parse(bundle.outputBaseHashJson))
  const previousBaseHash = hashBody.previousBaseHash
  assertDomain(v.outputContractVersion === 2 ? previousBaseHash === null :
    typeof previousBaseHash === 'string' && HASH_PATTERN.test(previousBaseHash),
  'INVALID_PROJECT_VERSION', 'Fork3 source previous hash is absent or contradictory')
  if (bundle.schemaVersion === 'operational-output-version-bundle/v3') assertDomain(
    bundle.outputBaseHashJson === serializeOutputCanonicalJson(outputBoundVersionHashBodyV3({ state: bundle.state, previousBaseHash: previousBaseHash as string })),
  'INVALID_PROJECT_VERSION', 'Fork3 source base hash text is not its contract3 authority')
  const refs = Object.entries(v.snapshotRefs).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  assertDomain(input.snapshots.length === refs.length && new Set(input.snapshots.map(r => r.id)).size === refs.length,
    'INVALID_PROJECT_VERSION', 'Fork3 requires every actual source snapshot exactly once')
  const nonOutputSnapshotFacts: Record<'brief' | 'policies' | 'treatment' | 'story', ProjectSnapshot | null> =
    { brief: null, policies: null, treatment: null, story: null }
  for (const [kind, id] of refs) {
    const row = input.snapshots.find(r => r.id === id), expectedKind = kind === 'editPlan' ? 'edit-plan' : kind
    assertDomain(row !== undefined && row.schemaVersion === 1 && row.kind === expectedKind &&
      row.workspaceId === v.workspaceId && row.projectId === v.projectId &&
      serializeOutputCanonicalJson(createProjectSnapshot(row)) === serializeOutputCanonicalJson(row) &&
      row.contentJson === stableSerialize(JSON.parse(row.contentJson)) &&
      createHash('sha256').update(row.contentJson, 'utf8').digest('hex') === row.contentHash,
    'INVALID_PROJECT_VERSION', 'Fork3 source snapshot row/body/scope differs')
    if (expectedKind === 'edit-plan') assertDomain(same(row, plan), 'INVALID_PROJECT_VERSION', 'Fork3 source EditPlan envelope differs')
    else {
      assertDomain(['brief', 'policies', 'treatment', 'story'].includes(expectedKind),
        'INVALID_PROJECT_VERSION', 'Fork3 does not transfer acceptance or perception snapshots')
      nonOutputSnapshotFacts[expectedKind as keyof typeof nonOutputSnapshotFacts] = row
    }
  }
  const anchor = s.document.renderablePlan, compiled = input.renderablePlanSnapshot
  assertDomain(anchor === null ? compiled === null && blockedCandidate === null :
    s.document.schemaVersion === 'project-output-state/v3' ? compiled !== null && blockedCandidate === null :
      compiled === null && blockedCandidate !== null && 'candidateId' in anchor && anchor.candidateId === blockedCandidate.id && anchor.planHash === blockedCandidate.planHash,
    'INVALID_PROJECT_VERSION', 'Fork3 requires exact executable renderable source presence')
  if (compiled !== null) {
    const row = createV2RenderablePlanSnapshotFacts(compiled)
    assertDomain(anchor !== null && 'snapshotId' in anchor && anchor.snapshotId === row.id && anchor.hash === row.planHash &&
      row.projectVersionId === v.id && row.projectId === v.projectId && row.workspaceId === v.workspaceId,
    'INVALID_PROJECT_VERSION', 'Fork3 source compiled receipt binding differs')
  }
  const source = freezeOutputJson({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, schemaVersion: 'project-fork-source/v3',
    bundle, bundleHash: calculateOutputCanonicalHash(bundle), bundleCanonicalJson: serializeOutputCanonicalJson(bundle),
    version: v, state: s, facts, nonOutputSnapshotFacts,
    previousBaseHash, outputBaseHashJson: bundle.outputBaseHashJson } as unknown as OutputJson) as unknown as Readonly<ProjectForkSourceV3>
  if (input.renderablePlanSnapshot === null) validatedUncompiledForkSourcesV3.add(source)
  return source
}

export function validateProjectForkSourceV3(input: Readonly<ProjectForkSourceV3>,
  renderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null): Readonly<ProjectForkSourceV3> {
  if (renderablePlanSnapshot === null && validatedUncompiledForkSourcesV3.has(input)) return input
  forkExact(input, ['schemaVersion', 'canonicalPolicyVersion', 'bundle', 'bundleHash', 'bundleCanonicalJson', 'version', 'state',
    'facts', 'nonOutputSnapshotFacts', 'previousBaseHash', 'outputBaseHashJson'])
  const plan = operationalBundlePlanV3(input.bundle)
  const fresh = createProjectForkSourceV3({ bundle: input.bundle,
    snapshots: [plan, ...Object.values(input.nonOutputSnapshotFacts).filter((s): s is ProjectSnapshot => s !== null)], renderablePlanSnapshot })
  assertDomain(same(input, fresh), 'INVALID_PROJECT_VERSION', 'Fork3 source projection differs from its actual receipt')
  return fresh
}

export function forkOwnedIdentitiesV3(sourceInput: Readonly<ProjectForkSourceV3>,
  compiled: Readonly<V2RenderablePlanSnapshotFacts> | null): readonly Readonly<{ kind: ForkIdentityKindV2; id: string }>[] {
  const source = validateProjectForkSourceV3(sourceInput, compiled), members: {kind: ForkIdentityKindV2; id: string}[] = []
  const seen = new Set<string>()
  const add = (kind: ForkIdentityKindV2, id: unknown) => {
    assertDomain(isForkIdentityV2(kind, id), 'INVALID_COMMAND', 'Fork3 owned identity is invalid')
    const key = kind + ':' + id
    if (!seen.has(key)) { seen.add(key); members.push({kind, id}) }
  }
  add('version', source.version.id); add('state', source.state.document.id)
  for (const id of Object.values(source.version.snapshotRefs)) if (id !== undefined) add('snapshot', id)
  if (compiled !== null) add('renderable-snapshot', compiled.id)
  if (source.bundle.schemaVersion === 'project-creation-output-bundle/v2' && source.bundle.command.payload.renderableCandidate !== null)
    add('renderable-snapshot', source.bundle.command.payload.renderableCandidate.id)
  for (const entry of source.state.document.entries) { add('variant', entry.variantId); add('revision', entry.outputSpecRevisionId) }
  for (const overlay of source.state.document.overlays) add('overlay', overlay.id)
  for (const issue of source.state.document.invalidations) add('invalidation', issue.id)
  for (const [kind, document] of [['edit-plan', source.facts.editPlanDocument], ['renderable-plan', source.facts.renderablePlanDocument]] as const) {
    if (document === null) continue
    const plan = object(document), planSeen = new Set<string>(); add(kind, plan.id)
    const own = (kind: ForkIdentityKindV2, id: unknown) => {
      const key = kind + ':' + id
      assertDomain(!planSeen.has(key), 'INVALID_COMMAND', 'Fork3 typed plan repeats an owned identity')
      planSeen.add(key); add(kind, id)
    }
    for (const [collection, identityKind] of [['sources', 'plan-source'], ['videoTracks', 'track'], ['subtitleTracks', 'track'],
      ['audioTracks', 'track'], ['overlayTracks', 'track'], ['effectTracks', 'track'], ['markers', 'marker'],
      ['protectedElements', 'protected-element'], ['transitions', 'transition']] as const) {
      if (plan[collection] === undefined) continue
      assertDomain(Array.isArray(plan[collection]), 'INVALID_COMMAND', 'Fork3 typed plan container is absent')
      for (const value of plan[collection] as unknown[]) {
        const row = object(value); if (row.id !== undefined) own(identityKind, row.id)
        for (const [children, childKind] of (collection === 'videoTracks' ? [['clips', 'clip']] as const :
          collection === 'subtitleTracks' ? [['cues', 'cue']] as const : [])) {
          assertDomain(Array.isArray(row[children]), 'INVALID_COMMAND', 'Fork3 typed children must be explicit')
          for (const child of row[children] as unknown[]) own(childKind, object(child).id)
        }
      }
    }
  }
  return Object.freeze(members.map(m => Object.freeze(m)))
}

export interface ProjectForkKernelBodyV3 extends Omit<ProjectForkDerivationBody, 'schemaVersion' | 'source'> {
  schemaVersion: 'project-fork-kernel/v3'
  source: Readonly<ProjectForkSourceV3>
}
export interface ProjectForkDerivationBodyV3 extends Omit<ProjectForkDerivationBodyV2, 'schemaVersion' | 'kernel'> {
  schemaVersion: 'project-fork-derivation/v3'
  kernel: Readonly<{ schemaVersion: 'project-fork-kernel/v3'; document: Readonly<ProjectForkKernelBodyV3>; derivationHash: string }>
}
export interface ProjectForkDerivationV3 {
  schemaVersion: 'project-fork-derivation/v3'; document: Readonly<ProjectForkDerivationBodyV3>; derivationHash: string
}

export function remapForkSnapshotDocumentV3(document: unknown, kind: ProjectSnapshot['kind'] | 'renderable-plan',
  source: Readonly<ProjectForkSourceV3>, a: Readonly<OutputOriginAllocation>, map: readonly Readonly<ForkIdentityRemapV2>[],
  compiled: Readonly<V2RenderablePlanSnapshotFacts> | null): unknown {
  const index = indexForkIdentityBijectionV2(forkOwnedIdentitiesV3(source, compiled), map)
  return remapForkDocumentWithIndex(document, kind, { version: source.version, ...source.facts,
    nonOutputSnapshotFacts: source.nonOutputSnapshotFacts }, a, index, true)
}

export function createProjectForkKernelV3(input: ProjectForkKernelBodyV3): ProjectForkDerivationBodyV3['kernel'] {
  forkExact(input, ['canonicalPolicyVersion', 'schemaVersion', 'id', 'callerIntent', 'audit', 'target',
    'source', 'sourceRenderablePlanSnapshot', 'identityMap', 'cropDecisions', 'compilePolicyVersion'])
  validateOutputCanonicalPolicy(input); serializeOutputCanonicalJson(input)
  assertDomain(input.schemaVersion === 'project-fork-kernel/v3' && ID_PATTERN.test(input.id) &&
    input.compilePolicyVersion === PROJECT_FORK_COMPILE_POLICY_VERSION, 'INVALID_COMMAND', 'Fork3 kernel identity/policy differs')
  forkExact(input.callerIntent, ['schemaVersion', 'kind', 'name'])
  assertDomain(input.callerIntent.schemaVersion === 'project-creation-intent/v2' && input.callerIntent.kind === 'fork-with-content' &&
    normalizeProjectName(input.callerIntent.name) === input.callerIntent.name && input.callerIntent.name.length >= 1 && input.callerIntent.name.length <= 120,
  'INVALID_COMMAND', 'Fork3 requires explicit normalized caller intent')
  const audit = createApiAccessAuditContext(input.audit), a = input.target
  forkExact(a, ['commandId', 'workspaceId', 'projectId', 'resultVersionId', 'stateId', 'parentVersionId', 'sequence', 'createdBy', 'createdAt'])
  assertDomain(same(audit, input.audit) && audit.workspaceId === a.workspaceId && a.createdBy === audit.clientId,
    'AUTH_INVALID', 'Fork3 target actor binding differs')
  assertDomain([a.commandId, a.workspaceId, a.projectId, a.resultVersionId, a.stateId].every(id => ID_PATTERN.test(id)) &&
    a.parentVersionId === null && a.sequence === 1 && new Set([a.commandId, a.projectId, a.resultVersionId, a.stateId]).size === 4 &&
    new Date(a.createdAt).toISOString() === a.createdAt, 'INVALID_COMMAND', 'Fork3 requires a new root allocation')
  const source = validateProjectForkSourceV3(input.source, input.sourceRenderablePlanSnapshot)
  assertDomain(source.version.workspaceId === a.workspaceId && source.version.projectId !== a.projectId &&
    Array.isArray(input.identityMap) && input.identityMap.length <= 100_000 && Array.isArray(input.cropDecisions),
  'INVALID_COMMAND', 'Fork3 source scope/map differs')
  const owned = forkOwnedIdentitiesV3(source, input.sourceRenderablePlanSnapshot)
  const index = indexForkIdentityBijectionV2(owned, input.identityMap)
  const excluded = new Set([input.id, a.commandId, a.workspaceId, a.projectId, source.version.projectId])
  assertDomain(!owned.some(m => excluded.has(m.id) && m.id !== a.workspaceId) &&
    ![a.commandId, a.workspaceId, a.projectId, a.resultVersionId, a.stateId].includes(input.id) &&
    [...index.values()].every(id => !excluded.has(id)) && index.get('version:' + source.version.id) === a.resultVersionId &&
    index.get('state:' + source.state.document.id) === a.stateId, 'INVALID_COMMAND', 'Fork3 allocations are not an exact independent bijection')
  const overlays = new Map(source.state.document.overlays.map(overlay => [overlay.id, overlay])), seen = new Set<string>()
  assertDomain(input.cropDecisions.length === overlays.size, 'INVALID_COMMAND', 'Fork3 must retain every crop decision')
  for (const decision of input.cropDecisions) {
    forkExact(decision as unknown, ['sourceOverlayId', 'sourceOverlayHash', 'newOverlayId', 'newVariantId', 'newClipId',
      'copiedDocument', 'author', 'createdAt', 'geometryStatus'])
    const original = overlays.get(decision.sourceOverlayId)
    assertDomain(original !== undefined && !seen.has(original.id) && decision.sourceOverlayHash === calculateOutputCanonicalHash(original) &&
      same(decision.copiedDocument, original.document) && decision.newOverlayId === index.get('overlay:' + original.id) &&
      decision.newVariantId === index.get('variant:' + original.variantId) && decision.newClipId === index.get('clip:' + original.clipId) &&
      same(decision.author, { type: 'api-client', id: audit.clientId, ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}) }) &&
      decision.createdAt === a.createdAt && decision.geometryStatus === 'requires-target-materialization',
    'INVALID_COMMAND', 'Fork3 crop lineage/identity/audit differs')
    seen.add(original.id)
  }
  const document = freezeOutputJson(input as unknown as OutputJson) as unknown as Readonly<ProjectForkKernelBodyV3>
  return Object.freeze({ schemaVersion: 'project-fork-kernel/v3', document, derivationHash: calculateOutputCanonicalHash(document) })
}

export function createProjectForkDerivationV3(input: ProjectForkDerivationBodyV3): Readonly<ProjectForkDerivationV3> {
  forkExact(input, ['schemaVersion', 'canonicalPolicyVersion', 'id', 'kernel', 'kernelCanonicalJson',
    'sourceEditPlanSnapshot', 'sourceProject', 'sourceReferences'])
  validateOutputCanonicalPolicy(input)
  forkExact(input.kernel, ['schemaVersion', 'document', 'derivationHash'])
  const kernel = createProjectForkKernelV3(input.kernel.document), source = kernel.document.source, project = input.sourceProject
  assertDomain(input.schemaVersion === 'project-fork-derivation/v3' && input.id === kernel.document.id && same(input.kernel, kernel) &&
    input.kernelCanonicalJson === serializeOutputCanonicalJson(kernel.document) &&
    createHash('sha256').update(input.kernelCanonicalJson, 'utf8').digest('hex') === kernel.derivationHash,
  'INVALID_COMMAND', 'Fork3 derivation/kernel raw seals differ')
  forkExact(project, ['id', 'workspaceId', 'currentVersionId', 'name', 'status', 'format', 'ownerId', 'administrationRevision',
    'updatedAt', 'objective', 'locale', 'createdByType', 'createdById', 'createdAt'])
  assertDomain(project.id === source.version.projectId && project.workspaceId === source.version.workspaceId &&
    project.currentVersionId === source.version.id && typeof project.name === 'string' && project.name.length > 0 &&
    PROJECT_STATUSES.includes(project.status as (typeof PROJECT_STATUSES)[number]) && project.status !== 'archived' &&
    (project.format === null || typeof project.format === 'string') && (project.ownerId === null || typeof project.ownerId === 'string') &&
    Number.isSafeInteger(project.administrationRevision) && project.administrationRevision > 0 &&
    new Date(project.updatedAt).toISOString() === project.updatedAt && new Date(project.createdAt).toISOString() === project.createdAt &&
    typeof project.objective === 'string' && project.objective.length > 0 && (project.locale === null || (typeof project.locale === 'string' && project.locale.length > 0)) &&
    ['api-client', 'user', 'system', 'director'].includes(project.createdByType) && typeof project.createdById === 'string' && project.createdById.length > 0,
  'INVALID_COMMAND', 'Fork3 actual source Project/head/lifecycle facts differ')
  assertDomain(same(input.sourceEditPlanSnapshot, operationalBundlePlanV3(source.bundle)),
    'INVALID_COMMAND', 'Fork3 source EditPlan is not the exact receipt snapshot')
  validateForkMediaReferenceFacts(input.sourceReferences, project, source)
  const document = freezeOutputJson({ ...input, kernel } as unknown as OutputJson) as unknown as Readonly<ProjectForkDerivationBodyV3>
  const derivation = freezeOutputJson({ schemaVersion: input.schemaVersion, document, derivationHash: calculateOutputCanonicalHash(document) } as unknown as OutputJson) as unknown as Readonly<ProjectForkDerivationV3>
  validatedForkDerivationsV3.add(derivation)
  return derivation
}

export function validateProjectForkDerivationV3(input: ProjectForkDerivationV3): Readonly<ProjectForkDerivationV3> {
  if (validatedForkDerivationsV3.has(input)) return input
  forkExact(input, ['schemaVersion', 'document', 'derivationHash'])
  const fresh = createProjectForkDerivationV3(input.document)
  assertDomain(same(input, fresh), 'INVALID_COMMAND', 'Fork3 complete derivation seal differs')
  return fresh
}

export function materializeForkEditPlanV3(input: ProjectForkDerivationV3): Readonly<Record<string, unknown>> {
  const d = validateProjectForkDerivationV3(input).document, k = d.kernel.document
  const plan = object(remapForkSnapshotDocumentV3(k.source.facts.editPlanDocument, 'edit-plan', k.source,
    k.target, k.identityMap, k.sourceRenderablePlanSnapshot))
  // Direction/manual approval is never inherited. The original values remain
  // sealed in source.bundle; target content is governed by its own Command.
  for (const key of ['directorRunId', 'director', 'manualEditing']) delete plan[key]
  return freezeOutputJson(plan as OutputJson) as Readonly<Record<string, unknown>>
}

export interface ForkRenderablePlanCandidateV3 extends Omit<ForkRenderablePlanCandidate,
  'schemaVersion' | 'derivationRef'> {
  schemaVersion: 'project-fork-renderable-candidate/v3'
  planHashJson: string
  audioAuthority: ForkRenderablePlanCandidateV2['audioAuthority']
  derivationRef: Readonly<OutputCanonicalPolicy & { schemaVersion: 'project-fork-derivation-ref/v3'; id: string; hash: string;
    compilePolicyVersion: typeof PROJECT_FORK_COMPILE_POLICY_VERSION }>
  source: Readonly<{ outputContractVersion: 2 | 3; kind: 'renderable-snapshot' | 'blocked-fork-candidate';
    id: string; planId: string; planHash: string }>
  consumption: Readonly<{ status: 'blocked'; reason: 'fork-target-materialization-required' }>
}

export function buildForkRenderablePlanCandidateV3(input: ProjectForkDerivationV3): Readonly<ForkRenderablePlanCandidateV3> | null {
  const d = validateProjectForkDerivationV3(input), k = d.document.kernel.document, source = k.source
  const snapshot = k.sourceRenderablePlanSnapshot
  const candidate = source.bundle.schemaVersion === 'project-creation-output-bundle/v2' ? source.bundle.command.payload.renderableCandidate : null
  if (snapshot === null && candidate === null) return null
  const original = snapshot ?? candidate!
  const index = indexForkIdentityBijectionV2(forkOwnedIdentitiesV3(source, snapshot), k.identityMap)
  const plan = object(remapForkSnapshotDocumentV3(source.facts.renderablePlanDocument, 'renderable-plan', source, k.target, k.identityMap, snapshot))
  for (const key of ['directorRunId', 'storyPlanId', 'treatmentPlanId', 'director', 'manualEditing']) delete plan[key]
  const planHashJson = serializeOutputCanonicalJson({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'project-fork-renderable-plan-hash/v3', compilePolicyVersion: k.compilePolicyVersion, plan })
  const originalPlan = object(source.facts.renderablePlanDocument) as unknown as DirectedEditPlan
  const clips = originalPlan.videoTracks.find(t => t.kind === 'base-video')!.clips
  const sourceSpeechHash = createEditorialAudioTimelineHash({fps: originalPlan.fps, clips})
  const sourceSpeechCanonicalJson = stableSerialize({ schemaVersion: 'editorial-audio-timeline/v1', fps: Number(originalPlan.fps.toFixed(6)),
    segments: clips.map(clip => ({ artifactId: clip.audioSourceArtifactId ?? clip.sourceArtifactId,
      audioSourceInFrame: clip.audioSourceInFrame ?? clip.sourceInFrame, audioSourceOutFrame: clip.audioSourceOutFrame ?? clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate })) })
  const sourceMixedCanonicalJson = originalPlan.audioTracks.length ? stableSerialize({ schemaVersion: 'directed-audio-timeline/v1', speechHash: sourceSpeechHash, musicTracks: originalPlan.audioTracks }) : null
  const musicTracks = plan.audioTracks as DirectedEditPlan['audioTracks']
  const targetMixedCanonicalJson = musicTracks.length ? stableSerialize({ schemaVersion: 'directed-audio-timeline/v1', speechHash: sourceSpeechHash, musicTracks }) : null
  assertDomain(createHash('sha256').update(sourceSpeechCanonicalJson).digest('hex') === sourceSpeechHash &&
    createHash('sha256').update(sourceMixedCanonicalJson ?? sourceSpeechCanonicalJson).digest('hex') === originalPlan.audioTimelineHash &&
    createHash('sha256').update(targetMixedCanonicalJson ?? sourceSpeechCanonicalJson).digest('hex') === plan.audioTimelineHash,
  'INVALID_COMMAND', 'Fork3 preserves actual speech/music authority text without importing acceptance')
  return freezeOutputJson({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, schemaVersion: 'project-fork-renderable-candidate/v3',
    id: index.get('renderable-snapshot:' + original.id)!, workspaceId: k.target.workspaceId, projectId: k.target.projectId,
    projectVersionId: k.target.resultVersionId, planId: plan.id, fps: plan.fps, durationFrames: plan.durationFrames,
    clipCount: (plan.videoTracks as {clips:unknown[]}[]).reduce((n,track) => n + track.clips.length, 0),
    planJson: serializeOutputCanonicalJson(plan), planHashJson, planHash: createHash('sha256').update(planHashJson, 'utf8').digest('hex'),
    audioAuthority: { schemaVersion: 'fork-audio-projection/v1', sourceSpeechCanonicalJson, sourceSpeechHash, sourceMixedCanonicalJson, targetMixedCanonicalJson },
    derivationRef: { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, schemaVersion: 'project-fork-derivation-ref/v3',
      id: d.document.id, hash: d.derivationHash, compilePolicyVersion: k.compilePolicyVersion },
    source: { outputContractVersion: source.version.outputContractVersion, kind: snapshot === null ? 'blocked-fork-candidate' : 'renderable-snapshot',
      id: original.id, planId: original.planId, planHash: original.planHash },
    consumption: { status: 'blocked', reason: 'fork-target-materialization-required' }, createdAt: k.target.createdAt } as unknown as OutputJson) as unknown as Readonly<ForkRenderablePlanCandidateV3>
}

/** Caller/source facts contain no fresh target allocation and no mutable
 * approval/rights claim. The transaction confronts the retained source receipt
 * and evaluates current lifecycle/rights under its own locks and clock. */
export function forkCreationSourceBaselineV3(input: ProjectForkDerivationV3) {
  const d = validateProjectForkDerivationV3(input).document, k = d.kernel.document, source = k.source
  const snapshots = [source.nonOutputSnapshotFacts.brief, source.nonOutputSnapshotFacts.policies,
    source.nonOutputSnapshotFacts.treatment, source.nonOutputSnapshotFacts.story, d.sourceEditPlanSnapshot].filter((s): s is ProjectSnapshot => s !== null)
  return { workspaceId: source.version.workspaceId, projectId: source.version.projectId, versionId: source.version.id,
    baseHash: source.version.baseHash, stateId: source.state.document.id, stateHash: source.state.stateHash,
    sourceContractVersion: source.version.outputContractVersion, sourceReceiptHash: source.bundleHash,
    snapshots: snapshots.map(s => ({kind: s.kind, id: s.id, hash: s.contentHash})),
    renderablePlanSnapshot: k.sourceRenderablePlanSnapshot, sourceProject: d.sourceProject,
    sourceReferences: d.sourceReferences.map(({targetLinkId, ...fact}) => { void targetLinkId; return fact }),
    ownedIdentities: forkOwnedIdentitiesV3(source, k.sourceRenderablePlanSnapshot).toSorted((a,b) =>
      Buffer.compare(Buffer.from(a.kind + ':' + a.id), Buffer.from(b.kind + ':' + b.id))) }
}
export interface ForkRenderablePlanCandidateV2 extends Omit<ForkRenderablePlanCandidate,
  'schemaVersion' | 'derivationRef'> {
  schemaVersion: 'project-fork-renderable-candidate/v2'
  planHashJson: string
  audioAuthority: Readonly<{ schemaVersion: 'fork-audio-projection/v1'; sourceSpeechCanonicalJson: string; sourceSpeechHash: string;
    sourceMixedCanonicalJson: string | null; targetMixedCanonicalJson: string | null }>
  derivationRef: Readonly<ForkDerivationReferenceV2>
}
export function forkDerivationReferenceV2(derivation: ProjectForkDerivationV2): Readonly<ForkDerivationReferenceV2> {
  const d = validateProjectForkDerivationV2(derivation)
  return Object.freeze({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'project-fork-derivation-ref/v2', id: d.document.id, hash: d.derivationHash,
    compilePolicyVersion: d.document.kernel.document.compilePolicyVersion })
}
export function materializeForkEditPlanV2(derivation: ProjectForkDerivationV2): Readonly<Record<string, unknown>> {
  const d = validateProjectForkDerivationV2(derivation)
  return freezeOutputJson({ ...materializeForkEditPlan(d.document.kernel),
    forkDerivationRef: forkDerivationReferenceV2(d) } as unknown as OutputJson) as Readonly<Record<string, unknown>>
}
export function buildForkRenderablePlanCandidateV2(derivation: ProjectForkDerivationV2): Readonly<ForkRenderablePlanCandidateV2> | null {
  const d = validateProjectForkDerivationV2(derivation), kernel = d.document.kernel, source = kernel.document.sourceRenderablePlanSnapshot
  if (source === null) return null
  const index = indexForkIdentityBijectionV2(forkOwnedIdentities(kernel.document.source, source), kernel.document.identityMap)
  const plan = { ...materializeForkRenderablePlan(kernel), forkDerivationRef: forkDerivationReferenceV2(d) }
  const original=JSON.parse(source.planJson) as DirectedEditPlan
  const originalClips=original.videoTracks.find(t=>t.kind==='base-video')!.clips
  const sourceSpeechHash=createEditorialAudioTimelineHash({fps:original.fps,clips:originalClips})
  const speechBody={schemaVersion:'editorial-audio-timeline/v1',fps:Number(original.fps.toFixed(6)),segments:originalClips.map(clip=>({
    artifactId:clip.audioSourceArtifactId ?? clip.sourceArtifactId,audioSourceInFrame:clip.audioSourceInFrame ?? clip.sourceInFrame,
    audioSourceOutFrame:clip.audioSourceOutFrame ?? clip.sourceOutFrame,timelineInFrame:clip.timelineInFrame,timelineOutFrame:clip.timelineOutFrame,rate:clip.rate}))}
  const sourceSpeechCanonicalJson=stableSerialize(speechBody)
  const sourceMixedCanonicalJson=original.audioTracks.length ? stableSerialize({schemaVersion:'directed-audio-timeline/v1',speechHash:sourceSpeechHash,musicTracks:original.audioTracks}) : null
  const targetMixedCanonicalJson=plan.audioTracks.length ? stableSerialize({schemaVersion:'directed-audio-timeline/v1',speechHash:sourceSpeechHash,musicTracks:plan.audioTracks}) : null
  assertDomain(createHash('sha256').update(sourceSpeechCanonicalJson).digest('hex')===sourceSpeechHash &&
    createHash('sha256').update(sourceMixedCanonicalJson ?? sourceSpeechCanonicalJson).digest('hex')===original.audioTimelineHash &&
    createHash('sha256').update(targetMixedCanonicalJson ?? sourceSpeechCanonicalJson).digest('hex')===plan.audioTimelineHash,
    'INVALID_COMMAND','Fork audio textual projections differ from real historical constructors')
  const audioAuthority={schemaVersion:'fork-audio-projection/v1',sourceSpeechCanonicalJson,sourceSpeechHash,sourceMixedCanonicalJson,targetMixedCanonicalJson}
  const hashBody = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'project-fork-renderable-plan-hash/v2', compilePolicyVersion: kernel.document.compilePolicyVersion, plan }
  const planHashJson = serializeOutputCanonicalJson(hashBody), planHash = calculateOutputCanonicalHash(hashBody)
  return freezeOutputJson({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'project-fork-renderable-candidate/v2', id: index.get('renderable-snapshot:' + source.id)!,
    workspaceId: kernel.document.target.workspaceId, projectId: kernel.document.target.projectId,
    projectVersionId: kernel.document.target.resultVersionId, planId: plan.id,
    derivationRef: forkDerivationReferenceV2(d), fps: plan.fps, durationFrames: plan.durationFrames,
    clipCount: plan.videoTracks.reduce((n, track) => n + track.clips.length, 0),
    planJson: serializeOutputCanonicalJson(plan), planHashJson, planHash, audioAuthority, createdAt: kernel.document.target.createdAt } as unknown as OutputJson) as unknown as Readonly<ForkRenderablePlanCandidateV2>
}

function validateForkMediaReferenceFacts(references: readonly Readonly<ForkMediaReferenceFactsV2>[],
  project: ProjectForkDerivationBodyV2['sourceProject'], source: Readonly<OutputVersionBundle | ProjectForkSourceV3>): void {
  const referenced = new Set<string>()
  for (const plan of [source.facts.editPlanDocument, source.facts.renderablePlanDocument]) {
    if (!plan) continue
    const p = plan as { sources?: { artifactId: string }[]; videoTracks?: { clips: { sourceArtifactId: string; audioSourceArtifactId?: string }[] }[]; audioTracks?: { artifactId?: string }[] }
    for (const reference of p.sources ?? []) referenced.add(reference.artifactId)
    for (const track of p.videoTracks ?? []) for (const clip of track.clips) {
      referenced.add(clip.sourceArtifactId)
      if (clip.audioSourceArtifactId !== undefined) referenced.add(clip.audioSourceArtifactId)
    }
    for (const track of p.audioTracks ?? []) if (track.artifactId) referenced.add(track.artifactId)
  }
  const normalizationFacts = new Map<string, import('./output-materialization.ts').OutputArtifactFactV3>()
  if ('schemaVersion' in source && source.schemaVersion === 'project-fork-source/v3' && source.state.document.schemaVersion === 'project-output-state/v3') {
    for (const entry of source.state.document.entries) if (entry.consumption.status === 'materialized') {
      for (const normalization of entry.consumption.materialization.document.normalizations) {
        for (const fact of [normalization.document.source, normalization.document.derivative]) {
          const key = fact.artifactId + ':' + fact.manifestId, previous = normalizationFacts.get(key)
          assertDomain(previous === undefined || same(previous, fact), 'INVALID_COMMAND', 'Fork3 normalization source facts contradict each other')
          normalizationFacts.set(key, fact); referenced.add(fact.artifactId)
        }
      }
    }
  }
  const links = new Set<string>(), targets = new Set<string>(), artifacts = new Set<string>()
  assertDomain(Array.isArray(references), 'INVALID_COMMAND', 'Fork media facts missing')
  for (const ref of references) {
    forkExact(ref as unknown, ['sourceLinkId', 'targetLinkId', 'workspaceId', 'sourceProjectId', 'artifactId', 'role',
      'originalFileName', 'sourceLinkCreatedAt', 'artifactKey', 'artifactSha256', 'artifactByteSize', 'artifactMediaType',
      'artifactContainer', 'artifactLifecycleRevision', 'purpose', 'manifestFacts'])
    assertDomain(ref.workspaceId === project.workspaceId && ref.sourceProjectId === project.id &&
      ['source-master', 'source-audio', 'source-image', 'editing-proxy', 'editorial-proxy', 'final-output', 'selected-insert'].includes(ref.role) &&
      ref.purpose === (ref.role === 'selected-insert' ? 'editorial-reuse' : 'editing') &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.sourceLinkId) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.targetLinkId) &&
      ref.targetLinkId !== ref.sourceLinkId && !links.has(ref.sourceLinkId) && !targets.has(ref.targetLinkId) &&
      typeof ref.originalFileName === 'string' && ref.originalFileName.length > 0 && ref.originalFileName.length <= 240 &&
      /^[a-f0-9]{64}$/.test(ref.artifactSha256) && /^[1-9][0-9]*$/.test(ref.artifactByteSize) &&
      Number.isSafeInteger(ref.artifactLifecycleRevision) && ref.artifactLifecycleRevision > 0 &&
      ['video', 'audio', 'image'].includes(ref.artifactMediaType) && ref.artifactContainer.length > 0 &&
      new Date(ref.sourceLinkCreatedAt).toISOString() === ref.sourceLinkCreatedAt,
      'INVALID_COMMAND', 'Fork media facts identity/scope/purpose mismatch')
    const mf=ref.manifestFacts
    forkExact(mf as unknown,['id','artifactId','workspaceId','schemaVersion','manifestJson','manifestHash','createdAt','recipeId','recipeVersion','parametersHash','recipeParametersRef','renderInputRef','renderInputHash','recipeParameters','renderInput'])
    let manifest: import('./media-artifact.ts').MediaArtifactManifest
    try { manifest=JSON.parse(mf.manifestJson); assertMediaArtifactManifest(manifest) }
    catch { assertDomain(false,'INVALID_COMMAND','Fork actual manifest document invalid') }
    assertDomain(mf.artifactId===ref.artifactId && mf.workspaceId===ref.workspaceId && mf.schemaVersion===manifest.schemaVersion &&
      mf.manifestHash===manifest.manifestHash && manifest.artifact.artifactKey===ref.artifactKey && mf.recipeId===manifest.recipe.id && mf.recipeVersion===manifest.recipe.version && mf.parametersHash===manifest.recipe.parametersHash && manifest.artifact.sha256===ref.artifactSha256 && String(manifest.artifact.byteSize)===ref.artifactByteSize &&
      manifest.artifact.mediaType===ref.artifactMediaType && manifest.artifact.container===ref.artifactContainer && new Date(mf.createdAt).toISOString()===mf.createdAt,
      'INVALID_COMMAND','Fork manifest row/artifact facts mismatch')
    if (manifest.schemaVersion==='media-artifact-manifest/v3' || manifest.schemaVersion==='media-artifact-manifest/v4') {
      assertDomain(mf.recipeParametersRef===manifest.recipe.parametersRef && mf.recipeParameters!==null,'INVALID_COMMAND','Fork protected recipe facts missing')
      validateForkProtectedMetadataV2(mf.recipeParameters,ref.workspaceId,manifest.recipe.parametersRef,manifest.recipe.parametersHash,'recipe-parameters')
    } else assertDomain(mf.recipeParametersRef===null && mf.recipeParameters===null,'INVALID_COMMAND','Inline recipe cannot invent protected payload facts')
    if (manifest.schemaVersion==='media-artifact-manifest/v4') {
      assertDomain(mf.renderInputRef===manifest.renderInput.ref && mf.renderInputHash===manifest.renderInput.inputHash && mf.renderInput!==null,
        'INVALID_COMMAND','Fork protected RenderInput facts missing')
      validateForkProtectedMetadataV2(mf.renderInput,ref.workspaceId,manifest.renderInput.ref,manifest.renderInput.inputHash,'render-input')
    } else assertDomain(mf.renderInputRef===null && mf.renderInputHash===null && mf.renderInput===null,'INVALID_COMMAND','Manifest cannot invent RenderInput payload facts')
    for (const entry of source.state.document.entries) if ('geometry' in entry && entry.geometry.status==='verified') for (const clip of entry.geometry.projection.clips) {
      if (clip.sourceArtifactId===ref.artifactId) assertDomain(clip.sourceManifestId===mf.id && clip.sourceManifestHash===mf.manifestHash && clip.sourceSha256===ref.artifactSha256,
        'INVALID_COMMAND','Fork geometry source manifest facts differ')
    }
    links.add(ref.sourceLinkId); targets.add(ref.targetLinkId); artifacts.add(ref.artifactId)
  }
  assertDomain([...targets].every((id) => !links.has(id)) &&
    [...referenced].every((id) => artifacts.has(id)), 'INVALID_COMMAND', 'Fork media bijection or referenced artifact facts incomplete')
  for (const fact of normalizationFacts.values()) assertDomain(references.some(ref => ref.artifactId === fact.artifactId &&
    ref.manifestFacts.id === fact.manifestId && same(JSON.parse(ref.manifestFacts.manifestJson), fact.manifest)),
  'INVALID_COMMAND', 'Fork3 requires actual manifest facts for every sealed normalization source/derivative')
}
