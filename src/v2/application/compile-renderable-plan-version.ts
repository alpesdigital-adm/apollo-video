import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { createEditCommand, type CommandActor, type EditCommand } from '../domain/edit-command.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../domain/output-version-bundle.ts'
import type { V2RenderablePlanSnapshotFacts } from '../domain/project-fork-derivation.ts'
import { reidentifiedEditPlanSnapshot } from '../domain/project-output-state-transition.ts'
import {
  createRenderableCompilePayload, renderableCompileIdentity, renderableCompileRequestFingerprint,
  renderableSnapshotRowId, type RenderableCompileKey, type RenderableCompilePayload,
} from '../domain/renderable-compile-command.ts'
import { transitionRenderableCompileOutputState } from '../domain/renderable-compile-transition.ts'
import type { RenderablePlanSnapshot } from './ports/renderable-plan-snapshot-repository.ts'

/**
 * The Version a renderable plan is born with (see `renderable-compile-command.ts` for the contract).
 *
 * A compiler cannot know the Version its plan belongs to until that Version's identity is fixed, because the plan document carries
 * it and the plan's hash covers the document. The identity is therefore derived from the natural key of the compile (the project,
 * the derivation at its hash and the head it is compiled on), exported here as `renderableCompileVersionId` for the compilers to
 * ask for before they assemble the plan. `projectVersionId` in every compile request is that head.
 */
export function renderableCompileVersionId(key: Readonly<RenderableCompileKey>): string {
  return renderableCompileIdentity(key).versionId
}

/** Who the Command names as its author, and the credential audit that goes with an external one. */
export function renderableCompileAuthor(input: Readonly<{
  workspaceId: string
  actor: Readonly<{ kind: 'human' | 'api-client' | 'director' | 'system'; id: string; delegatedUserId?: string }>
  audit?: Readonly<ApiAccessAuditContext> | null
}>): Readonly<{ author: Readonly<CommandActor>; audit: Readonly<ApiAccessAuditContext> | null }> {
  const { actor, audit } = input
  if (actor.kind === 'api-client') {
    // An external author is only as good as its credential audit: a bare client id would seal a Command nobody can attribute.
    if (!audit || audit.workspaceId !== input.workspaceId || audit.clientId !== actor.id) {
      throw new DomainError('AUTH_INVALID', 'A renderable compile by an API client requires the credential audit of that client')
    }
    return Object.freeze({
      author: Object.freeze({ type: 'api-client' as const, id: audit.clientId, ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}) }),
      audit,
    })
  }
  assertDomain(!audit, 'AUTH_INVALID', 'Only an external actor carries a credential audit')
  return Object.freeze({
    author: Object.freeze({ type: actor.kind === 'human' ? 'user' as const : actor.kind, id: actor.id, ...(actor.delegatedUserId ? { delegatedUserId: actor.delegatedUserId } : {}) }),
    audit: null,
  })
}

export interface PreparedRenderableCompileVersion {
  readonly bundle: Readonly<OperationalOutputVersionBundleV3>
  /** The row the Version publishes, to be written beside it by the shared persistence file. */
  readonly renderableSnapshot: Readonly<V2RenderablePlanSnapshotFacts>
  readonly command: Readonly<EditCommand<RenderableCompilePayload>>
  readonly identity: ReturnType<typeof renderableCompileIdentity>
  /** Exactly what `transitionRenderableCompileOutputState` was given, so a reader can reproduce the bundle. */
  readonly transition: Parameters<typeof transitionRenderableCompileOutputState>[0]
}

/**
 * Seal the Version for one compiled plan: the Command, the EditPlan snapshot that is the head's plan under the new identity, the
 * row and the bundle that binds them. Pure; the repository supplies the exact head and writes the result.
 */
export function prepareRenderableCompileVersion(input: Readonly<{
  parent: OperationalOutputParentV3
  snapshot: Readonly<RenderablePlanSnapshot>
  /** Defaults to the row id derived from the snapshot's natural key. */
  snapshotRowId?: string
  author: Readonly<CommandActor>
  audit: Readonly<ApiAccessAuditContext> | null
  createdAt: string
  createMaterializationId: () => string
}>): Readonly<PreparedRenderableCompileVersion> {
  const { parent, snapshot, author, audit, createdAt } = input
  const key: RenderableCompileKey = Object.freeze({ workspaceId: parent.version.workspaceId, projectId: parent.version.projectId,
    origin: snapshot.origin, sourceId: snapshot.sourceId, sourceHash: snapshot.sourceHash, baseVersionId: parent.version.id })
  assertDomain(snapshot.workspaceId === key.workspaceId && snapshot.projectId === key.projectId, 'INVALID_COMMAND',
    'The renderable plan was compiled for another workspace or project than the head')
  const identity = renderableCompileIdentity(key)
  assertDomain(snapshot.plan.projectVersionId === identity.versionId, 'INVALID_COMMAND',
    'The renderable plan must be compiled into the Version its compile creates, derived from the head it is compiled on',
    { planProjectVersionId: snapshot.plan.projectVersionId, expectedProjectVersionId: identity.versionId })
  const renderableSnapshot: Readonly<V2RenderablePlanSnapshotFacts> = Object.freeze({
    id: input.snapshotRowId ?? renderableSnapshotRowId({ workspaceId: key.workspaceId, origin: snapshot.origin, sourceId: snapshot.sourceId,
      sourceHash: snapshot.sourceHash, projectVersionId: identity.versionId, fps: snapshot.fps }),
    workspaceId: snapshot.workspaceId, projectId: snapshot.projectId, projectVersionId: identity.versionId, planId: snapshot.planId,
    origin: snapshot.origin, sourceId: snapshot.sourceId, sourceHash: snapshot.sourceHash, sourceVersion: snapshot.sourceVersion, fps: snapshot.fps,
    durationFrames: snapshot.durationFrames, clipCount: snapshot.clipCount, planJson: JSON.stringify(snapshot.plan), planHash: snapshot.planHash, createdAt,
  })
  const editPlanSnapshot = reidentifiedEditPlanSnapshot(parent, { snapshotId: identity.editPlanSnapshotId, versionId: identity.versionId, createdAt })
  const payload = createRenderableCompilePayload({ commandId: identity.commandId, baseVersionId: parent.version.id, resultVersionId: identity.versionId,
    preservedEditPlanSnapshotId: editPlanSnapshot.id, renderableSnapshot })
  const command = createEditCommand<RenderableCompilePayload>({
    id: identity.commandId, workspaceId: key.workspaceId, projectId: key.projectId, baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
    author, type: 'compile-renderable-plan', scope: { project: true }, payload, idempotencyKey: identity.idempotencyKey, createdAt,
  })
  const transition = Object.freeze({
    parent,
    allocation: Object.freeze({ workspaceId: key.workspaceId, projectId: key.projectId, resultVersionId: identity.versionId, stateId: identity.stateId,
      parentVersionId: parent.version.id, sequence: parent.version.sequence + 1, createdBy: author.id, createdAt }),
    command, audit,
    requestFingerprint: renderableCompileRequestFingerprint({ key, sourceVersion: snapshot.sourceVersion, fps: snapshot.fps, planHash: snapshot.planHash, audit, author }),
    editPlanSnapshot, renderableSnapshot, createMaterializationId: input.createMaterializationId,
  })
  return Object.freeze({ bundle: transitionRenderableCompileOutputState(transition), renderableSnapshot, command, identity, transition })
}
