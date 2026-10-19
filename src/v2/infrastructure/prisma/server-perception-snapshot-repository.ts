import {
  type Prisma, type PrismaClient, type V2ServerPerceptionSnapshot, type V2ServerPerceptionSnapshotCoverage,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedServerPerceptionSnapshot, ServerPerceptionSnapshotRepository,
} from '../../application/ports/server-perception-snapshot-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { PERCEPTION_KINDS } from '../../domain/perception-timeline.ts'
import {
  serverPerceptionSnapshotId, verifyServerPerceptionSnapshot, type ServerPerceptionSnapshot,
} from '../../domain/server-perception-snapshot.ts'
import { settleDeferredOutputGuards } from './project-version-commit.ts'

type StoredSnapshot = V2ServerPerceptionSnapshot & { coverage: V2ServerPerceptionSnapshotCoverage[] }

function conflict(message: string): never {
  throw new DomainError('PERSISTENCE_CONFLICT', `Stored server perception snapshot failed validation: ${message}`)
}

/** The nine per-kind rows the snapshot's own timeline implies: what the database must hold next to the JSON. */
function coverageRows(snapshot: Readonly<ServerPerceptionSnapshot>) {
  return PERCEPTION_KINDS.map((kind) => {
    const entry = snapshot.timeline.coverage.find((candidate) => candidate.kind === kind)!
    return {
      snapshotId: serverPerceptionSnapshotId(snapshot.snapshotHash), workspaceId: snapshot.workspaceId, kind,
      state: entry.state, observedMs: entry.observedMs, durationMs: snapshot.timeBase.durationMs,
      observationCount: snapshot.timeline.observations.filter((item) => item.kind === kind).length,
      reasonCode: entry.reasonCode ?? null,
    }
  })
}

/**
 * Rebuilds a stored row into the snapshot it claims to be, and proves it: the JSON re-derives (hash, timeline, every state and
 * range, per-kind invariants), the columns agree with it, and the nine coverage rows the database holds are the ones the JSON implies.
 */
function hydrate(row: StoredSnapshot): Readonly<PersistedServerPerceptionSnapshot> {
  let parsed: unknown
  try { parsed = JSON.parse(row.snapshotJson) } catch { return conflict('JSON') }
  const snapshot = verifyServerPerceptionSnapshot(parsed)
  if (stableSerialize(snapshot) !== row.snapshotJson) conflict('JSON is not canonical')
  if (row.id !== serverPerceptionSnapshotId(snapshot.snapshotHash) || row.snapshotHash !== snapshot.snapshotHash ||
      row.timelineHash !== snapshot.timeline.timelineHash || row.schemaVersion !== snapshot.schemaVersion ||
      row.workspaceId !== snapshot.workspaceId || row.projectId !== snapshot.projectId ||
      row.projectVersionId !== snapshot.projectVersionId || row.editPlanSnapshotId !== snapshot.editPlan.snapshotId ||
      row.editPlanSnapshotHash !== snapshot.editPlan.snapshotHash ||
      row.durationFrames !== snapshot.timeBase.durationFrames || row.durationMs !== snapshot.timeBase.durationMs) {
    conflict('columns differ from sealed content')
  }
  const expected = coverageRows(snapshot)
  if (row.coverage.length !== expected.length) conflict('coverage rows are not the nine kinds')
  for (const want of expected) {
    const have = row.coverage.find((candidate) => candidate.kind === want.kind)
    if (!have || have.snapshotId !== want.snapshotId || have.workspaceId !== want.workspaceId || have.state !== want.state ||
        have.observedMs !== want.observedMs || have.durationMs !== want.durationMs ||
        have.observationCount !== want.observationCount || have.reasonCode !== want.reasonCode) {
      conflict(`coverage of ${want.kind} differs from the snapshot`)
    }
  }
  return Object.freeze({
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, projectVersionId: row.projectVersionId,
    snapshot, createdAt: row.createdAt.toISOString(),
  })
}

/**
 * Writes the snapshot and its nine coverage rows inside the caller's transaction, once: the same content for the same Version is a
 * no-op (`ON CONFLICT DO NOTHING`), so any number of concurrent writers leave exactly one row. Returns whether this call wrote it.
 * The nine-kinds guard is a deferred constraint: the caller settles it (`SET CONSTRAINTS ALL IMMEDIATE`) when its own writes are done.
 */
export async function insertServerPerceptionSnapshot(
  transaction: Prisma.TransactionClient, snapshot: Readonly<ServerPerceptionSnapshot>, createdAt: Date,
): Promise<boolean> {
  verifyServerPerceptionSnapshot(snapshot)
  if (snapshot.editPlan.snapshotHash === null || snapshot.sources.some((source) => source.sha256 === null)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'A server perception snapshot is stored only with its EditPlan hash and every source hash verified')
  }
  const inserted = await transaction.v2ServerPerceptionSnapshot.createMany({ skipDuplicates: true, data: [{
    id: serverPerceptionSnapshotId(snapshot.snapshotHash), workspaceId: snapshot.workspaceId, projectId: snapshot.projectId,
    projectVersionId: snapshot.projectVersionId, editPlanSnapshotId: snapshot.editPlan.snapshotId,
    editPlanSnapshotHash: snapshot.editPlan.snapshotHash, durationFrames: snapshot.timeBase.durationFrames,
    durationMs: snapshot.timeBase.durationMs, schemaVersion: snapshot.schemaVersion,
    snapshotJson: stableSerialize(snapshot), snapshotHash: snapshot.snapshotHash,
    timelineHash: snapshot.timeline.timelineHash, createdAt,
  }] })
  if (inserted.count === 0) return false
  await transaction.v2ServerPerceptionSnapshotCoverage.createMany({ data: coverageRows(snapshot) })
  return true
}

/** Reads and re-verifies the stored snapshot of this content for this Version, or null when none is stored. */
export async function readServerPerceptionSnapshot(
  client: PrismaClient | Prisma.TransactionClient,
  where: { workspaceId: string; projectId: string; projectVersionId: string; snapshotHash: string },
) {
  const row = await client.v2ServerPerceptionSnapshot.findFirst({ where, include: { coverage: true } })
  return row ? hydrate(row) : null
}

export class PrismaServerPerceptionSnapshotRepository implements ServerPerceptionSnapshotRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }

  async findByHash(input: { workspaceId: string; projectId: string; projectVersionId: string; snapshotHash: string }) {
    return readServerPerceptionSnapshot(this.client, input)
  }

  async persistIfAbsent(input: { snapshot: Readonly<ServerPerceptionSnapshot>; createdAt: string }) {
    const snapshot = verifyServerPerceptionSnapshot(input.snapshot)
    if (!Number.isFinite(Date.parse(input.createdAt))) throw new DomainError('INVALID_ARGUMENT', 'Snapshot creation time is invalid')
    const where = { workspaceId: snapshot.workspaceId, projectId: snapshot.projectId,
      projectVersionId: snapshot.projectVersionId, snapshotHash: snapshot.snapshotHash }
    const existing = await readServerPerceptionSnapshot(this.client, where)
    if (existing) return Object.freeze({ record: existing, created: false })
    const created = await this.client.$transaction(async (transaction) => {
      const wrote = await insertServerPerceptionSnapshot(transaction, snapshot, new Date(input.createdAt))
      // The nine-kinds guard is a deferred constraint: settle it here, so a refusal is this call's error and not a lost COMMIT.
      await settleDeferredOutputGuards(transaction)
      return wrote
    })
    const stored = await readServerPerceptionSnapshot(this.client, where)
    if (!stored) conflict('the row disappeared after it was written')
    return Object.freeze({ record: stored!, created })
  }
}
