import type { Prisma, PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  RenderablePlanSnapshot,
  RenderablePlanSnapshotRepository,
  StoredRenderablePlanSnapshot,
} from '../../application/ports/renderable-plan-snapshot-repository.ts'
import {
  RENDERABLE_PLAN_ORIGINS,
  calculateRenderablePlanHash,
  type RenderablePlanOrigin,
} from '../../application/renderable-edit-plan.ts'
import { validateDirectedEditPlan, type DirectedEditPlan } from '../../domain/director-run.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { commitRenderablePlanVersionInTransaction, persistRenderablePlanVersion } from './renderable-plan-version-commit.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** A unique violation, whether Prisma modelled the insert (P2002) or a raw INSERT surfaced PostgreSQL's 23505 (P2010). */
function isUniqueViolation(error: unknown): boolean {
  if (isPrismaCode(error, 'P2002')) return true
  const meta = typeof error === 'object' && error !== null && 'meta' in error ? (error as { meta?: { code?: unknown } }).meta : undefined
  return isPrismaCode(error, 'P2010') && meta?.code === '23505'
}

interface SnapshotRow {
  workspaceId: string
  projectId: string
  projectVersionId: string
  planId: string
  origin: string
  sourceId: string
  sourceHash: string
  sourceVersion: number | null
  fps: number
  durationFrames: number
  clipCount: number
  planJson: string
  planHash: string
  createdAt: Date
}

/**
 * Read a stored plan back, and refuse one that does not match its own hash.
 *
 * The hash is recomputed from the parsed plan rather than trusted from the
 * column, so an UPDATE underneath the application — a clip's frame numbers
 * edited by hand, a source swapped, a critic decision injected — makes the row
 * unreadable instead of making the renderer produce a cut nobody compiled. It
 * covers the whole document (`calculateRenderablePlanHash`), which is what makes
 * it worth recomputing: a hash over a projection would leave the rest of the
 * plan writable by anyone with an UPDATE.
 *
 * The validator runs too, and after the hash on purpose. The hash answers "is
 * this the document the compiler wrote"; the validator answers "is this a plan
 * at all". A row that fails the first is tampered and says so; a row that
 * carries a self-consistent hash over a document the domain would refuse is a
 * plan written by something that is not this compiler, and it must not reach a
 * renderer either.
 */
function hydrate(row: SnapshotRow): Readonly<StoredRenderablePlanSnapshot> {
  let parsed: Readonly<DirectedEditPlan>
  try {
    parsed = JSON.parse(row.planJson) as Readonly<DirectedEditPlan>
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored renderable plan ${row.planId} is not valid JSON`,
    )
  }
  if (!RENDERABLE_PLAN_ORIGINS.includes(row.origin as RenderablePlanOrigin)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored renderable plan ${row.planId} names an unknown origin`,
      { origin: row.origin },
    )
  }
  const recomputed = calculateRenderablePlanHash(parsed)
  if (recomputed !== row.planHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored renderable plan ${row.planId} does not match its hash`,
      { planId: row.planId, storedHash: row.planHash, recomputedHash: recomputed },
    )
  }
  let plan: Readonly<DirectedEditPlan>
  try {
    plan = validateDirectedEditPlan(parsed)
  } catch (error) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored renderable plan ${row.planId} is not a renderable plan any more`,
      { planId: row.planId, reason: error instanceof Error ? error.message : String(error) },
    )
  }
  return Object.freeze({
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planId: row.planId,
    origin: row.origin as RenderablePlanOrigin,
    sourceId: row.sourceId,
    sourceHash: row.sourceHash,
    sourceVersion: row.sourceVersion,
    fps: row.fps,
    durationFrames: row.durationFrames,
    clipCount: row.clipCount,
    plan: Object.freeze(plan),
    planHash: row.planHash,
    createdAt: row.createdAt.toISOString(),
  })
}

const SNAPSHOT_SELECT = {
  workspaceId: true,
  projectId: true,
  projectVersionId: true,
  planId: true,
  origin: true,
  sourceId: true,
  sourceHash: true,
  sourceVersion: true,
  fps: true,
  durationFrames: true,
  clipCount: true,
  planJson: true,
  planHash: true,
  createdAt: true,
} as const

export class PrismaRenderablePlanSnapshotRepository implements RenderablePlanSnapshotRepository {
  private readonly client: PrismaClient | Prisma.TransactionClient

  constructor(client: PrismaClient | Prisma.TransactionClient = getV2PostgresClient()) {
    this.client = client
  }

  async readByPlan(input: { workspaceId: string; projectId: string; planId: string; planHash: string }) {
    const row = await this.client.v2RenderablePlanSnapshot.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        planId: input.planId,
        planHash: input.planHash,
      },
      select: SNAPSHOT_SELECT,
    })
    return row ? hydrate(row) : null
  }

  async persist(input: Parameters<RenderablePlanSnapshotRepository['persist']>[0]): Promise<Readonly<{ snapshot: Readonly<StoredRenderablePlanSnapshot>; replayed: boolean }>> {
    const { snapshot } = input
    // The natural key of the bridge: one derivation, at one hash, compiled into one project version (the child of the head the
    // caller compiled on, whose id the plan document carries), delivered at one frame rate. A retry lands on the same row, and
    // it is found before anything is written: the first compile moved the head, so the base the retry names is no longer it.
    //
    // The rate is the caller's, not the source's. `planFps` is a published knob of the compile capability and it is the
    // timebase every clip is expressed in, so the same map at 25/1 and at 30/1 are two documents with two plan hashes. The
    // objective is not here on purpose: see `renderable_plan_delivery_rate_key`.
    //
    // The DB's `renderable_plan_snapshots_source_key` holds the same columns and is what actually enforces this.
    const replay = await this.replayOf(snapshot)
    if (replay) return replay
    try {
      // The row is never inserted on its own: the database admits it only with the Version whose State binds it, and that Version
      // is written by the one shared Version writer. Inside a caller's transaction the caller settles the deferred guards.
      const request = { snapshot, baseVersionId: input.baseVersionId, author: input.author, audit: input.audit, createdAt: input.createdAt }
      if ('$transaction' in this.client) await persistRenderablePlanVersion(this.client, request)
      else await commitRenderablePlanVersionInTransaction(this.client, request)
    } catch (error) {
      // A concurrent identical compile won the head or the key: what it stored is the answer, whatever this one saw. Inside a
      // caller's transaction a failure aborts that transaction, so there is nothing left to read: the caller's rollback answers.
      const lost = isUniqueViolation(error) || (error instanceof DomainError && error.code === 'VERSION_CONFLICT')
      if (!lost || !('$transaction' in this.client)) throw error
      const racing = await this.replayOf(snapshot)
      if (racing) return racing
      if (error instanceof DomainError) throw error
      // Another Command took the Version number (or the key) after this one read the head: the project moved, which the caller
      // answers like every other Command based on a Version that is no longer the head.
      throw new DomainError('VERSION_CONFLICT', 'The project moved while the renderable plan was being compiled; read its head and compile on it',
        { baseVersionId: input.baseVersionId })
    }
    // Read back rather than handing the caller its own object: the round trip is where a plan that cannot be rehydrated is still
    // cheap to fix.
    const written = await this.readByKey(snapshot)
    if (!written) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `The renderable plan for ${snapshot.sourceId} vanished between write and read`,
      )
    }
    return Object.freeze({ snapshot: written, replayed: false })
  }

  /**
   * The stored answer for this key. Same key, same cut: the caller compiled twice and gets the first answer. Same key, different
   * cut: the request was identical down to the delivery rate, so what changed the compiler's output was not the request — a
   * compiler that moved, or a row edited underneath — and overwriting the plan somebody already rendered would erase the evidence
   * of what was rendered. The details name the whole key: "a different plan is stored for that source hash" left a reader guessing
   * which part of their request had collided.
   */
  private async replayOf(snapshot: Readonly<RenderablePlanSnapshot>): Promise<Readonly<{ snapshot: Readonly<StoredRenderablePlanSnapshot>; replayed: true }> | null> {
    const stored = await this.readByKey(snapshot)
    if (!stored) return null
    if (stored.planHash === snapshot.planHash) return Object.freeze({ snapshot: stored, replayed: true as const })
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `A different plan is already stored for ${snapshot.origin} ${snapshot.sourceId} at that hash, in project version ${snapshot.plan.projectVersionId} at ${snapshot.fps} fps`,
      {
        sourceId: snapshot.sourceId,
        projectVersionId: snapshot.plan.projectVersionId,
        fps: snapshot.fps,
        storedPlanHash: stored.planHash,
        incomingPlanHash: snapshot.planHash,
      },
    )
  }

  private async readByKey(
    snapshot: Readonly<RenderablePlanSnapshot>,
  ): Promise<Readonly<StoredRenderablePlanSnapshot> | null> {
    const row = await this.client.v2RenderablePlanSnapshot.findFirst({
      where: {
        workspaceId: snapshot.workspaceId,
        origin: snapshot.origin,
        sourceId: snapshot.sourceId,
        sourceHash: snapshot.sourceHash,
        projectVersionId: snapshot.plan.projectVersionId,
        fps: snapshot.fps,
      },
      select: SNAPSHOT_SELECT,
    })
    return row ? hydrate(row) : null
  }

  async readLatestForSource(input: {
    workspaceId: string
    origin: RenderablePlanOrigin
    sourceId: string
  }): Promise<Readonly<StoredRenderablePlanSnapshot> | null> {
    const row = await this.client.v2RenderablePlanSnapshot.findFirst({
      where: {
        workspaceId: input.workspaceId,
        origin: input.origin,
        sourceId: input.sourceId,
      },
      orderBy: { createdAt: 'desc' },
      select: SNAPSHOT_SELECT,
    })
    return row ? hydrate(row) : null
  }

  async listForProject(input: {
    workspaceId: string
    projectId: string
    origin?: RenderablePlanOrigin
    limit?: number
  }): Promise<readonly Readonly<StoredRenderablePlanSnapshot>[]> {
    const rows = await this.client.v2RenderablePlanSnapshot.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.origin ? { origin: input.origin } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 200),
      select: SNAPSHOT_SELECT,
    })
    return Object.freeze(rows.map(hydrate))
  }
}
