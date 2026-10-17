import type { ApiAccessAuditContext } from './api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { EditCommand } from './edit-command.ts'
import { CHILD_COMMAND_TRANSITIONS, CHILD_REPLACEABLE_SNAPSHOT_KINDS, type ChildReplaceableSnapshotKind } from './output-child-command.ts'
import type { SealedOutputNormalizationV3 } from './output-materialization.ts'
import { buildOperationalOutputVersionBundleV3, operationalBundlePlanV3, type OperationalOutputParentV3,
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

/**
 * The observations a child plan is materialized from: those its parent State already holds, restricted to the
 * sources the new plan consumes. A plan that consumes a source nobody has observed cannot be materialized, so
 * the Command is refused instead of sealing a Version whose outputs could not be rendered.
 */
export function observedNormalizationsFor(parent: OperationalOutputParentV3, plan: Readonly<Record<string, unknown>>): readonly SealedOutputNormalizationV3[] {
  if (plan.durationFrames === 0) return []
  const available = parentNormalizationsV3(parent), required = requiredSourceArtifactIds(plan)
  const missing = [...required].filter((id) => !available.some((n) => n.document.source.artifactId === id)).toSorted()
  assertDomain(missing.length === 0, 'PRECONDITION_REQUIRED', 'The new EditPlan consumes sources that have no observed normalization', { sourceArtifactIds: missing })
  return available.filter((n) => required.has(n.document.source.artifactId))
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
  const materializationIds = plan.durationFrames === 0 ? {} :
    Object.fromEntries(variantIds.map((variantId) => [variantId, input.createMaterializationId()]))
  return buildOperationalOutputVersionBundleV3({
    allocation: input.allocation,
    parent: input.parent,
    origin: { kind: 'child-command', command: input.command, audit: input.audit,
      requestFingerprint: input.requestFingerprint, replaces },
    restoreTarget: null,
    editPlanSnapshot: input.editPlanSnapshot,
    replacementSnapshots: replacements,
    normalizations: observedNormalizationsFor(input.parent, plan),
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
  createMaterializationId: () => string
}>): Readonly<OperationalOutputVersionBundleV3> {
  const payload = input.command.payload
  if (payload.action === 'apply' && payload.operation?.kind !== 'select') {
    assertDomain(input.restoreTarget === null, 'INVALID_COMMAND', 'Apply has no restore target')
    return transitionProjectOutputState({ parent: input.parent, allocation: input.allocation, command: input.command, audit: input.audit,
      requestFingerprint: input.requestFingerprint, editPlanSnapshot: input.editPlanSnapshot, createMaterializationId: input.createMaterializationId })
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
