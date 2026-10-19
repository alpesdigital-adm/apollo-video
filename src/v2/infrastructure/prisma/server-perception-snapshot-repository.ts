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
function isPrismaCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
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

export class PrismaServerPerceptionSnapshotRepository implements ServerPerceptionSnapshotRepository {
  constructor(private readonly client: PrismaClient) {}

  private async find(client: PrismaClient | Prisma.TransactionClient, where: {
    workspaceId: string; projectId: string; projectVersionId: string; snapshotHash: string
  }) {
    return client.v2ServerPerceptionSnapshot.findFirst({ where, include: { coverage: true } })
  }

  async findByHash(input: { workspaceId: string; projectId: string; projectVersionId: string; snapshotHash: string }) {
    const row = await this.find(this.client, input)
    return row ? hydrate(row) : null
  }

  async persistIfAbsent(input: { snapshot: Readonly<ServerPerceptionSnapshot>; createdAt: string }) {
    // A stored snapshot is fully bound: the sealed EditPlan and the bytes of every source the timeline plays.
    const snapshot = verifyServerPerceptionSnapshot(input.snapshot)
    if (snapshot.editPlan.snapshotHash === null || snapshot.sources.some((source) => source.sha256 === null)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'A server perception snapshot is stored only with its EditPlan hash and every source hash verified')
    }
    if (!Number.isFinite(Date.parse(input.createdAt))) throw new DomainError('INVALID_ARGUMENT', 'Snapshot creation time is invalid')
    const where = { workspaceId: snapshot.workspaceId, projectId: snapshot.projectId,
      projectVersionId: snapshot.projectVersionId, snapshotHash: snapshot.snapshotHash }
    const existing = await this.find(this.client, where)
    if (existing) return Object.freeze({ record: hydrate(existing), created: false })
    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2ServerPerceptionSnapshot.create({ data: {
          id: serverPerceptionSnapshotId(snapshot.snapshotHash), workspaceId: snapshot.workspaceId, projectId: snapshot.projectId,
          projectVersionId: snapshot.projectVersionId, editPlanSnapshotId: snapshot.editPlan.snapshotId,
          editPlanSnapshotHash: snapshot.editPlan.snapshotHash!, durationFrames: snapshot.timeBase.durationFrames,
          durationMs: snapshot.timeBase.durationMs, schemaVersion: snapshot.schemaVersion,
          snapshotJson: stableSerialize(snapshot), snapshotHash: snapshot.snapshotHash,
          timelineHash: snapshot.timeline.timelineHash, createdAt: new Date(input.createdAt),
        } })
        await transaction.v2ServerPerceptionSnapshotCoverage.createMany({ data: coverageRows(snapshot) })
        // The nine-kinds guard is a deferred constraint: settle it here, so a refusal is this call's error and not a lost COMMIT.
        await settleDeferredOutputGuards(transaction)
      })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      // Another writer sealed the very same content first: that row is the answer.
      const winner = await this.find(this.client, where)
      if (!winner) throw error
      return Object.freeze({ record: hydrate(winner), created: false })
    }
    const stored = await this.find(this.client, where)
    if (!stored) conflict('the row disappeared after it was written')
    return Object.freeze({ record: hydrate(stored!), created: true })
  }
}
