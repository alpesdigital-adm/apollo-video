import type { Prisma } from '../../../../generated/prisma-v2/index.js'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import type { OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import { externalActorAuditData } from './external-actor-audit.ts'
import { assertAdoptedObservationsCurrentV3, assertCurrentOutputSourceUseV3 } from './output-version-materializer.ts'
import { persistOutputVersionBundleInTransactionV3, persistRenderablePlanSnapshotInTransactionV3 } from './output-version-bundle-persistence.ts'
import type { V2RenderablePlanSnapshotFacts } from '../../domain/project-fork-derivation.ts'

type CommandBundle = OperationalOutputVersionBundleV3 & {
  origin: Extract<OperationalOutputVersionBundleV3['origin'], { kind: 'child-command' | 'inherit-command' | 'restore-command' | 'renderable-compile-command' }>
}

/**
 * The single place where a Version and its sealed output State are written for a Command that owns no
 * dedicated operation (a child Command, or a manual-edit selection/restore). A writer calls it exactly once
 * inside its own serializable transaction, after it has locked and revalidated the facts it depends on and
 * before it moves the project head:
 *
 *   0. the publication guard: the current rights and consent of every source the State materializes;
 *   1. the Command row, with the credential audit columns of an external author;
 *   2. every snapshot of the bundle (the new EditPlan and any replaced non-output snapshot);
 *   3. the Version, State, entries, materializations and the reciprocal bundle row;
 *   4. for a renderable compile only, the renderable plan snapshot row the State binds. The database refuses that row on its own:
 *      it is written here, after the Version it names, so the reciprocal binding exists when the deferred guard looks.
 *
 * It does not move `projects.currentVersionId`, write events, domain rows or invalidations: those stay
 * with the writer. The deferred database guard validates the whole bundle at COMMIT; nothing here
 * confers success. Use `readPersistedOperationalOutputBundleV3` after the commit to read it back.
 */
export async function commitProjectVersionWithOutputState(tx: Prisma.TransactionClient, bundle: OperationalOutputVersionBundleV3,
  renderableSnapshot?: Readonly<V2RenderablePlanSnapshotFacts>): Promise<void> {
  if (bundle.origin.kind !== 'child-command' && bundle.origin.kind !== 'inherit-command' && bundle.origin.kind !== 'restore-command' &&
    bundle.origin.kind !== 'renderable-compile-command') {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Only Command bundles are committed through the shared Version writer')
  }
  if ((bundle.origin.kind === 'renderable-compile-command') !== (renderableSnapshot !== undefined)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Only a renderable compile publishes a renderable plan snapshot, and it must publish it with its Version')
  }
  const { origin } = bundle as CommandBundle
  const command = origin.command, { commandHash: _commandHash, ...body } = command
  const audit = origin.audit === null ? null : externalActorAuditData(origin.audit, command.workspaceId, command.author.id)
  await assertAdoptedObservationsCurrentV3(tx, bundle)
  await assertCurrentOutputSourceUseV3(tx, bundle)
  await tx.v2EditCommand.create({ data: {
    id: command.id, workspaceId: command.workspaceId, projectId: command.projectId, baseVersionId: command.baseVersionId,
    baseHash: command.baseHash, type: command.type, scopeJson: stableSerialize(command.scope), payloadJson: stableSerialize(command.payload),
    reason: command.reason ?? null, actorType: command.author.type, actorId: command.author.id, delegatedUserId: command.author.delegatedUserId ?? null,
    actorCredentialId: audit?.actorCredentialId ?? null, actorEnvironment: audit?.actorEnvironment ?? null,
    actorAuthenticationKind: audit?.actorAuthenticationKind ?? null, actorContextHash: audit?.actorContextHash ?? null,
    actorDelegatedIdentityId: audit?.delegatedIdentityId ?? null, actorWorkspaceRole: audit?.workspaceRole ?? null,
    idempotencyKey: command.idempotencyKey, requestFingerprint: origin.requestFingerprint, commandHash: command.commandHash,
    commandJson: stableSerialize(body), outputPayloadJson: null, outputPayloadHash: null, createdAt: new Date(command.createdAt),
  } })
  await persistOutputVersionBundleInTransactionV3(tx, bundle)
  if (renderableSnapshot !== undefined) await persistRenderablePlanSnapshotInTransactionV3(tx, bundle, renderableSnapshot)
}

/**
 * The Version guards are deferred constraint triggers: they validate the whole bundle when the transaction ends. Prisma's
 * interactive transaction does not report a refused COMMIT (a deferred trigger that raises leaves the callback's value
 * returned and every row rolled back), so a writer that stops at COMMIT would answer success for a Version that was never
 * stored. Each writer therefore calls this as the LAST write of its own transaction, after the head, the events and its
 * domain rows: the guards then run inside the callback and a refusal rejects it, which rolls the transaction back.
 * Nothing may write or re-defer afterwards; reads are fine.
 */
export async function settleDeferredOutputGuards(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
}
