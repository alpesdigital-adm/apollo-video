import type { ApiAccessAuditContext } from './api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { EditCommand } from './edit-command.ts'
import { CHILD_COMMAND_TRANSITIONS, CHILD_REPLACEABLE_SNAPSHOT_KINDS, type ChildReplaceableSnapshotKind } from './output-child-command.ts'
import type { SealedOutputNormalizationV3 } from './output-materialization.ts'
import { buildOperationalOutputVersionBundleV3, operationalBundlePlanV3, type OperationalOutputParentV3,
  type OperationalOutputVersionBundleV3 } from './output-version-bundle.ts'
import type { OutputOriginAllocation } from './output-version-origin.ts'
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

/** The exact normalization observations a child must reuse: those its parent State already materialized. */
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
  const plan = JSON.parse(input.editPlanSnapshot.contentJson) as { durationFrames?: unknown }
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
    normalizations: parentNormalizationsV3(input.parent),
    materializationIds,
  })
}
