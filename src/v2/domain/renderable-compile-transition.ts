import type { ApiAccessAuditContext } from './api-access-control.ts'
import { assertDomain } from './errors.ts'
import type { EditCommand } from './edit-command.ts'
import { COPY_REQUIRES_EDITORIAL_CUT_REASON } from './output-child-command.ts'
import { buildOperationalOutputVersionBundleV3, forkAuthorityPendingV3, type OperationalOutputParentV3,
  type OperationalOutputVersionBundleV3 } from './output-version-bundle.ts'
import type { OutputOriginAllocation } from './output-version-origin.ts'
import type { V2RenderablePlanSnapshotFacts } from './project-fork-derivation.ts'
import { observedNormalizationsFor } from './project-output-state-transition.ts'
import type { ProjectSnapshot } from './project-snapshot.ts'
import type { RenderableCompilePayload } from './renderable-compile-command.ts'

/**
 * The only way a renderable plan produces a Version. It is pure, like `transitionProjectOutputState`: the caller supplies the exact
 * head, the Command its service sealed, the EditPlan snapshot that is the head's plan under the new identity and the row the
 * Command publishes (already compiled into the Version being born). The result is the complete sealed bundle; the row is returned
 * to the persistence layer beside it, never inside it, because the State carries its authority and its hash.
 *
 * It observes and adopts nothing: the head's materializations are the ones the new State re-materializes from, and a head that has
 * no explicit output variant, or a copy that no editorial cut has given target authority, refuses (the builder says why).
 */
export function transitionRenderableCompileOutputState(input: Readonly<{
  parent: OperationalOutputParentV3
  allocation: OutputOriginAllocation
  command: Readonly<EditCommand<RenderableCompilePayload>>
  /** Credential audit of an external author; null for internal actors. */
  audit: Readonly<ApiAccessAuditContext> | null
  requestFingerprint: string
  editPlanSnapshot: Readonly<ProjectSnapshot>
  renderableSnapshot: Readonly<V2RenderablePlanSnapshotFacts>
  createMaterializationId: () => string
}>): Readonly<OperationalOutputVersionBundleV3> {
  assertDomain(!forkAuthorityPendingV3(input.parent), 'PRECONDITION_REQUIRED',
    'Fork2 content requires target transcript/perception/geometry authority before child3', { reason: COPY_REQUIRES_EDITORIAL_CUT_REASON })
  const plan = JSON.parse(input.editPlanSnapshot.contentJson) as Record<string, unknown>
  const variantIds = input.parent.state.document.entries.map((entry) => entry.variantId)
  const materializationIds = plan.durationFrames === 0 ? {} :
    Object.fromEntries(variantIds.map((variantId) => [variantId, input.createMaterializationId()]))
  const observed = observedNormalizationsFor(input.parent, plan)
  return buildOperationalOutputVersionBundleV3({
    allocation: input.allocation,
    parent: input.parent,
    origin: { kind: 'renderable-compile-command', command: input.command, audit: input.audit, requestFingerprint: input.requestFingerprint },
    restoreTarget: null,
    editPlanSnapshot: input.editPlanSnapshot,
    renderableSnapshot: input.renderableSnapshot,
    normalizations: observed.normalizations,
    materializationIds,
  })
}
