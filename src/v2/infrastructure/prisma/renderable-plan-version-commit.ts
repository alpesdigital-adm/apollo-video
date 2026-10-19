import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import { prepareRenderableCompileVersion } from '../../application/compile-renderable-plan-version.ts'
import type { RenderablePlanSnapshot } from '../../application/ports/renderable-plan-snapshot-repository.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { CommandActor } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import type { OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { V2RenderablePlanSnapshotFacts } from '../../domain/project-fork-derivation.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { persistPublicEvents } from './public-event-outbox.ts'

export interface RenderablePlanVersionInput {
  readonly snapshot: Readonly<RenderablePlanSnapshot>
  /** The project head the cut is compiled on; its child is the Version the plan is born with. */
  readonly baseVersionId: string
  readonly author: Readonly<CommandActor>
  readonly audit: Readonly<ApiAccessAuditContext> | null
  readonly createdAt: string
}

/**
 * Create, inside the caller's serializable transaction, the Version a renderable plan is born with and move the project head to it.
 *
 *   1. the project head is the base the caller compiled on (otherwise the project moved: VERSION_CONFLICT);
 *   2. the head is read back through the sealed bundle, never reconstructed from its columns;
 *   3. the Command, the EditPlan snapshot, the Version, the State that binds the plan, and the plan snapshot row are written by the
 *      one shared Version writer (the database refuses any other way to insert the row);
 *   4. the head moves by compare-and-swap, and the `project.version.created` event is queued like every other Version's.
 *
 * It does NOT settle the deferred database guards: the transaction's owner does, as its last write (`settleDeferredOutputGuards`),
 * because the guards re-read the whole bundle only once the head and the event exist.
 */
export async function commitRenderablePlanVersionInTransaction(tx: Prisma.TransactionClient, input: RenderablePlanVersionInput): Promise<Readonly<{
  bundle: Readonly<OperationalOutputVersionBundleV3>
  renderableSnapshot: Readonly<V2RenderablePlanSnapshotFacts>
}>> {
  const { snapshot, baseVersionId } = input
  const scope = { workspaceId: snapshot.workspaceId, projectId: snapshot.projectId }
  const project = await tx.v2Project.findFirst({ where: { id: scope.projectId, workspaceId: scope.workspaceId }, select: { currentVersionId: true } })
  if (!project) throw new DomainError('PROJECT_NOT_FOUND', `Project ${scope.projectId} does not exist`)
  if (project.currentVersionId !== baseVersionId) {
    throw new DomainError('VERSION_CONFLICT', 'The project moved before the renderable plan was compiled; read its head and compile on it',
      { baseVersionId, currentVersionId: project.currentVersionId })
  }
  const parent = await readPersistedOperationalOutputBundleV3(tx, { ...scope, versionId: baseVersionId })
  if (!parent) throw new DomainError('VERSION_CONFLICT', 'The project head has no sealed output bundle to compile on', { baseVersionId })
  const prepared = prepareRenderableCompileVersion({
    parent, snapshot, author: input.author, audit: input.audit, createdAt: input.createdAt,
    createMaterializationId: () => `renderable-materialization-${randomUUID()}`,
  })
  const { bundle, renderableSnapshot, command } = prepared
  await commitProjectVersionWithOutputState(tx, bundle, renderableSnapshot)
  const moved = await tx.v2Project.updateMany({ where: { id: scope.projectId, workspaceId: scope.workspaceId, currentVersionId: baseVersionId },
    data: { currentVersionId: bundle.version.id } })
  if (moved.count !== 1) throw new DomainError('VERSION_CONFLICT', 'The project head changed while the renderable plan was being compiled', { baseVersionId })
  const version = bundle.version
  await persistPublicEvents(tx, [createPublicEvent({
    id: randomUUID(), type: 'project.version.created', version: '1.0.0', workspaceId: scope.workspaceId, occurredAt: input.createdAt, sequence: version.sequence,
    actor: input.author.type === 'api-client'
      ? { clientId: input.author.id, ...(input.author.delegatedUserId ? { userId: input.author.delegatedUserId } : {}) }
      : { userId: input.author.id },
    resource: { type: 'project-version', id: version.id },
    data: { projectId: scope.projectId, sequence: version.sequence, parentVersionId: version.parentVersionId, baseHash: version.baseHash, commandId: command.id,
      commandType: command.type, renderablePlanSnapshotId: renderableSnapshot.id, renderablePlanHash: renderableSnapshot.planHash, createdAt: input.createdAt },
  })])
  return Object.freeze({ bundle, renderableSnapshot })
}

/**
 * A renderable plan's Version in a transaction of its own: serializable, thirty seconds for the guard that re-reads the bundle, and
 * the deferred guards forced before the callback returns so a refused COMMIT fails this call instead of answering a plan that was
 * never stored. A serialization failure retries; the caller reads the stored row back after this resolves.
 */
export async function persistRenderablePlanVersion(client: PrismaClient, input: RenderablePlanVersionInput, attempt = 1): Promise<void> {
  try {
    await client.$transaction(async (tx) => {
      await commitRenderablePlanVersionInTransaction(tx, input)
      await settleDeferredOutputGuards(tx)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) return persistRenderablePlanVersion(client, input, attempt + 1)
    throw error
  }
}
