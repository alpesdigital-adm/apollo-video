import type { ApiAccessAuditContext } from './api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { EditCommand } from './edit-command.ts'
import { CHILD_COMMAND_TRANSITIONS, CHILD_REPLACEABLE_SNAPSHOT_KINDS, COPY_REQUIRES_EDITORIAL_CUT_REASON, isForkInheritableCommandType,
  type AdoptableObservationV3, type AdoptedObservationV3, type ChildReplaceableSnapshotKind } from './output-child-command.ts'
import { validateOutputNormalizationV3, type SealedOutputNormalizationV3 } from './output-materialization.ts'
import { buildOperationalOutputVersionBundleV3, editorialDerivedBindingV3, forkAuthorityPendingV3, operationalBundlePlanV3, type OperationalOutputParentV3,
  type OperationalOutputVersionBundleV3 } from './output-version-bundle.ts'
import type { OutputOriginAllocation } from './output-version-origin.ts'
import type { PersistedManualEditPayload } from './manual-editing.ts'
import { createProjectSnapshot, type ProjectSnapshot } from './project-snapshot.ts'

/**
 * The EditPlan of a Command whose declared effect is `preserves-plan`: the parent's plan, byte for byte,
 * under the identity of the Version it is born with (id, projectVersionId, createdAt). The bundle builder
 * refuses any other difference, so a writer cannot smuggle a plan change through this effect.
 */
export function reidentifiedEditPlanSnapshot(parent: OperationalOutputParentV3,
  input: Readonly<{ snapshotId: string; versionId: string; createdAt: string }>): Readonly<ProjectSnapshot> {
  const source = operationalBundlePlanV3(parent), plan = JSON.parse(source.contentJson) as Record<string, unknown>
  const next = { ...plan, id: `edit-plan-${input.versionId}`, projectVersionId: input.versionId,
    ...('createdAt' in plan ? { createdAt: input.createdAt } : {}) }
  return createProjectSnapshot({ id: input.snapshotId, workspaceId: source.workspaceId, projectId: source.projectId, kind: 'edit-plan',
    contentSchemaVersion: source.contentSchemaVersion, contentJson: stableSerialize(next), contentHash: calculateCanonicalHash(next),
    createdAt: input.createdAt })
}

/** The sealed Command, audit and request fingerprint a child bundle carries, typed by the caller's payload. */
export function childCommandOf<Payload>(bundle: Readonly<OperationalOutputVersionBundleV3>): Readonly<{
  command: Readonly<EditCommand<Payload>>; audit: Readonly<ApiAccessAuditContext> | null; requestFingerprint: string
}> {
  assertDomain(bundle.origin.kind === 'child-command', 'PERSISTENCE_CONFLICT', 'The bundle was not produced by a child Command')
  const origin = bundle.origin
  return Object.freeze({ command: origin.command as Readonly<EditCommand<Payload>>, audit: origin.audit, requestFingerprint: origin.requestFingerprint })
}

/** The source artifacts a plan consumes: every video clip (and the audio it names), and every background-music track. */
export function requiredSourceArtifactIds(plan: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const track of Array.isArray(plan.videoTracks) ? plan.videoTracks as readonly Record<string, unknown>[] : []) {
    for (const clip of Array.isArray(track.clips) ? track.clips as readonly Record<string, unknown>[] : []) {
      if (typeof clip.sourceArtifactId === 'string') ids.add(clip.sourceArtifactId)
      ids.add(typeof clip.audioSourceArtifactId === 'string' ? clip.audioSourceArtifactId : String(clip.sourceArtifactId))
    }
  }
  for (const track of Array.isArray(plan.audioTracks) ? plan.audioTracks as readonly Record<string, unknown>[] : []) {
    if (track.kind === 'background-music' && typeof track.artifactId === 'string') ids.add(track.artifactId)
  }
  return ids
}

/** The sources a plan consumes that the parent State does not observe (sorted); none for an empty plan. */
export function unobservedSourceArtifactIds(parent: OperationalOutputParentV3, plan: Readonly<Record<string, unknown>>): readonly string[] {
  if (plan.durationFrames === 0) return []
  const observed = new Set(parentNormalizationsV3(parent).map((n) => n.document.source.artifactId))
  return [...requiredSourceArtifactIds(plan)].filter((id) => !observed.has(id)).toSorted()
}

/**
 * The observations a child plan is materialized from: those its parent State already holds, restricted to the
 * sources the new plan consumes, and the receipts of the project's other recordings it ADOPTS for the rest.
 *
 * Fail-closed. A source the parent does not observe is adopted only from a receipt the caller offered for exactly that
 * source artifact: sealed, of this workspace and project, with current rights evidence, and the only receipt offered
 * for it. A source with no such receipt is an unobserved artifact and the Command is refused, naming it, instead of
 * sealing a Version whose outputs could not be rendered. Offers for sources the plan does not consume (or the
 * parent already observes) are ignored: adoption is never broader than consumption.
 */
export function observedNormalizationsFor(parent: OperationalOutputParentV3, plan: Readonly<Record<string, unknown>>,
  adoptable: readonly Readonly<AdoptableObservationV3>[] = []): Readonly<{
  normalizations: readonly SealedOutputNormalizationV3[]
  adoptions: readonly AdoptedObservationV3[]
}> {
  if (plan.durationFrames === 0) return Object.freeze({ normalizations: Object.freeze([]), adoptions: Object.freeze([]) })
  const available = parentNormalizationsV3(parent), required = requiredSourceArtifactIds(plan)
  const missing = unobservedSourceArtifactIds(parent, plan)
  const adoptedNormalizations: SealedOutputNormalizationV3[] = [], adoptions: AdoptedObservationV3[] = []
  const unobserved: string[] = [], withoutRights: string[] = []
  for (const sourceArtifactId of missing) {
    const offers = adoptable.filter((offer) => offer.normalization.document.source.artifactId === sourceArtifactId)
    if (offers.length === 0) { unobserved.push(sourceArtifactId); continue }
    assertDomain(offers.length === 1, 'INVALID_COMMAND', 'More than one receipt is offered for one source artifact', { sourceArtifactId })
    const offer = offers[0]!, normalization = validateOutputNormalizationV3(offer.normalization), document = normalization.document
    assertDomain(document.workspaceId === parent.version.workspaceId && document.projectId === parent.version.projectId, 'INVALID_COMMAND',
      'An adoptable observation belongs to another workspace or project', { sourceArtifactId })
    if (offer.rights === null) { withoutRights.push(sourceArtifactId); continue }
    adoptedNormalizations.push(normalization)
    adoptions.push(Object.freeze({
      receiptId: document.id, receiptHash: normalization.receiptHash, sourceArtifactId, sourceManifestId: document.source.manifestId,
      sourceManifestHash: document.source.manifest.manifestHash,
      rights: Object.freeze({ snapshotId: offer.rights.snapshotId, snapshotHash: offer.rights.snapshotHash, revision: offer.rights.revision }),
    }))
  }
  assertDomain(unobserved.length === 0, 'PRECONDITION_REQUIRED', 'The new EditPlan consumes sources that have no observed normalization', { sourceArtifactIds: unobserved })
  assertDomain(withoutRights.length === 0, 'ASSET_RIGHTS_BLOCKED', 'An adopted recording has no current rights evidence', { artifactIds: withoutRights })
  return Object.freeze({
    normalizations: Object.freeze([...available.filter((n) => required.has(n.document.source.artifactId)), ...adoptedNormalizations]),
    adoptions: Object.freeze(adoptions.toSorted((left, right) => (left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0))),
  })
}

/**
 * The observations a child of a cut copy is materialized from. The copy's authority is its editorial binding: it names every
 * receipt the cut bound, and a materialization under it carries all of them. A new plan may consume only sources those receipts
 * observe (the copy owns no recording of its own to adopt): one it does not is refused naming the artifact.
 */
export function derivedObservationsFor(parent: OperationalOutputParentV3, plan: Readonly<Record<string, unknown>>): Readonly<{
  normalizations: readonly SealedOutputNormalizationV3[]
  adoptions: readonly AdoptedObservationV3[]
}> {
  if (plan.durationFrames === 0) return Object.freeze({ normalizations: Object.freeze([]), adoptions: Object.freeze([]) })
  const missing = unobservedSourceArtifactIds(parent, plan)
  assertDomain(missing.length === 0, 'PRECONDITION_REQUIRED',
    'The new EditPlan consumes sources the editorial authority of this copy does not observe', { sourceArtifactIds: missing })
  return Object.freeze({ normalizations: Object.freeze([...parentNormalizationsV3(parent)]), adoptions: Object.freeze([]) })
}

/** Every normalization observation the parent State already materialized. */
export function parentNormalizationsV3(parent: OperationalOutputParentV3): readonly SealedOutputNormalizationV3[] {
  if (parent.state.document.schemaVersion !== 'project-output-state/v3') return []
  const unique = new Map<string, SealedOutputNormalizationV3>()
  for (const entry of parent.state.document.entries) {
    if (entry.consumption.status !== 'materialized') continue
    for (const normalization of entry.consumption.materialization.document.normalizations) unique.set(normalization.document.id, normalization)
  }
  return [...unique.values()]
}

/**
 * The only way a Command that owns no dedicated output origin produces a Version.
 * It is pure: the caller supplies the exact parent bundle, the Command its own service
 * sealed, the EditPlan snapshot that service compiled (and any non-output snapshot the
 * Command's declared effect replaces) and an id source for the new materializations.
 * The result is the complete sealed bundle (Version, State, snapshots); it never returns
 * a Version without a State and throws when the parent has no explicit output variant.
 */
export function transitionProjectOutputState(input: Readonly<{
  parent: OperationalOutputParentV3
  allocation: OutputOriginAllocation
  command: Readonly<EditCommand<unknown>>
  /** Credential audit of an external author; null for internal actors. */
  audit: Readonly<ApiAccessAuditContext> | null
  requestFingerprint: string
  editPlanSnapshot: Readonly<ProjectSnapshot>
  replacementSnapshots?: readonly Readonly<ProjectSnapshot>[]
  /** The persisted receipts of the project's other recordings a repository offers; adopted only as the plan consumes them. */
  adoptable?: readonly Readonly<AdoptableObservationV3>[]
  createMaterializationId: () => string
}>): Readonly<OperationalOutputVersionBundleV3> {
  const replacements = input.replacementSnapshots ?? []
  const replaces = replacements.map((snapshot) => {
    assertDomain((CHILD_REPLACEABLE_SNAPSHOT_KINDS as readonly string[]).includes(snapshot.kind), 'INVALID_COMMAND',
      'Only brief, policies, treatment and story snapshots can be replaced by a Command')
    return snapshot.kind as ChildReplaceableSnapshotKind
  }).toSorted()
  assertDomain(CHILD_COMMAND_TRANSITIONS[input.command.type as keyof typeof CHILD_COMMAND_TRANSITIONS] !== undefined,
    'INVALID_COMMAND', 'Command type has no declared child output transition')
  const plan = JSON.parse(input.editPlanSnapshot.contentJson) as Record<string, unknown>
  const variantIds = input.parent.state.document.entries.map((entry) => entry.variantId)
  // A copy that no editorial cut has given target authority observes nothing and materializes nothing: a Command that only
  // configures it keeps every entry blocked, and any other Command is refused with the reason the operator can act on.
  const awaitsEditorialCut = forkAuthorityPendingV3(input.parent)
  assertDomain(!awaitsEditorialCut || isForkInheritableCommandType(input.command.type), 'PRECONDITION_REQUIRED',
    'Fork2 content requires target transcript/perception/geometry authority before child3', { reason: COPY_REQUIRES_EDITORIAL_CUT_REASON })
  const materializationIds = plan.durationFrames === 0 || awaitsEditorialCut ? {} :
    Object.fromEntries(variantIds.map((variantId) => [variantId, input.createMaterializationId()]))
  const observed = awaitsEditorialCut ? Object.freeze({ normalizations: Object.freeze([]), adoptions: Object.freeze([]) }) :
    editorialDerivedBindingV3(input.parent) !== null ? derivedObservationsFor(input.parent, plan) :
    observedNormalizationsFor(input.parent, plan, input.adoptable)
  return buildOperationalOutputVersionBundleV3({
    allocation: input.allocation,
    parent: input.parent,
    origin: { kind: 'child-command', command: input.command, audit: input.audit,
      requestFingerprint: input.requestFingerprint, replaces, adoptions: observed.adoptions },
    restoreTarget: null,
    editPlanSnapshot: input.editPlanSnapshot,
    replacementSnapshots: replacements,
    normalizations: observed.normalizations,
    materializationIds,
  })
}

/** The sealed Command, audit and request fingerprint of a manual-edit bundle, whichever origin it took. */
export function manualEditCommandOf(bundle: Readonly<OperationalOutputVersionBundleV3>): Readonly<{
  kind: 'child-command' | 'inherit-command' | 'restore-command'
  command: Readonly<EditCommand<PersistedManualEditPayload>>
  audit: Readonly<ApiAccessAuditContext> | null
  requestFingerprint: string
}> {
  const origin = bundle.origin
  assertDomain(origin.kind === 'child-command' || origin.kind === 'inherit-command' || origin.kind === 'restore-command',
    'PERSISTENCE_CONFLICT', 'The bundle was not produced by a manual-edit Command')
  return Object.freeze({ kind: origin.kind, command: origin.command as Readonly<EditCommand<PersistedManualEditPayload>>,
    audit: origin.audit, requestFingerprint: origin.requestFingerprint })
}

/**
 * The output transition of one manual-edit Command. The Command's own action decides the origin, so a caller
 * cannot pick a weaker one: a render-free selection inherits (its plan is re-derived by the real constructor),
 * undo/redo/restore return to an exact factual target, and every other operation is a child Command that
 * recompiles the plan. The authors of all three are external clients: the audit is required.
 */
export function transitionManualEditOutputState(input: Readonly<{
  parent: OperationalOutputParentV3
  /** The exact factual target of undo, redo and restore; absent for apply. */
  restoreTarget: OperationalOutputParentV3 | null
  allocation: OutputOriginAllocation
  command: Readonly<EditCommand<PersistedManualEditPayload>>
  audit: Readonly<ApiAccessAuditContext>
  requestFingerprint: string
  editPlanSnapshot: Readonly<ProjectSnapshot>
  /** Offered receipts of the project's other recordings; only an apply (a recompiling child) can adopt them. */
  adoptable?: readonly Readonly<AdoptableObservationV3>[]
  createMaterializationId: () => string
}>): Readonly<OperationalOutputVersionBundleV3> {
  const payload = input.command.payload
  if (payload.action === 'apply' && payload.operation?.kind !== 'select') {
    assertDomain(input.restoreTarget === null, 'INVALID_COMMAND', 'Apply has no restore target')
    return transitionProjectOutputState({ parent: input.parent, allocation: input.allocation, command: input.command, audit: input.audit,
      requestFingerprint: input.requestFingerprint, editPlanSnapshot: input.editPlanSnapshot, createMaterializationId: input.createMaterializationId,
      ...(input.adoptable === undefined ? {} : { adoptable: input.adoptable }) })
  }
  const source = payload.action === 'apply' ? input.parent : input.restoreTarget
  assertDomain(source !== null && (payload.action === 'apply') === (input.restoreTarget === null), 'INVALID_COMMAND',
    'Undo, redo and restore require their exact factual target')
  const plan = JSON.parse(input.editPlanSnapshot.contentJson) as { durationFrames?: unknown }
  const materializationIds = plan.durationFrames === 0 ? {} :
    Object.fromEntries(source.state.document.entries.map((entry) => [entry.variantId, input.createMaterializationId()]))
  const target = input.restoreTarget
  return buildOperationalOutputVersionBundleV3({
    allocation: input.allocation, parent: input.parent, restoreTarget: target,
    origin: target === null ?
      { kind: 'inherit-command', command: input.command, audit: input.audit, requestFingerprint: input.requestFingerprint } :
      { kind: 'restore-command', command: input.command, audit: input.audit, requestFingerprint: input.requestFingerprint,
        target: { versionId: target.version.id, baseHash: target.version.baseHash, stateId: target.state.document.id, stateHash: target.state.stateHash } },
    editPlanSnapshot: input.editPlanSnapshot,
    normalizations: parentNormalizationsV3(source),
    materializationIds,
  })
}
