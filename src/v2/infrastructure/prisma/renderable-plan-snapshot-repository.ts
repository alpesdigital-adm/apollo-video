import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

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
import { childRowId } from './child-row-id.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
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
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async persist(input: {
    snapshot: Readonly<RenderablePlanSnapshot>
    createdAt: string
  }): Promise<Readonly<{ snapshot: Readonly<StoredRenderablePlanSnapshot>; replayed: boolean }>> {
    const { snapshot } = input
    // The natural key of the bridge, hashed into the row id: one derivation, at
    // one hash, for one project version. A retry lands on the same row.
    const id = childRowId([
      snapshot.workspaceId,
      snapshot.origin,
      snapshot.sourceId,
      snapshot.sourceHash.slice(0, 16),
      snapshot.plan.projectVersionId,
    ], 200)
    try {
      await this.client.v2RenderablePlanSnapshot.create({
        data: {
          id,
          workspaceId: snapshot.workspaceId,
          projectId: snapshot.projectId,
          projectVersionId: snapshot.plan.projectVersionId,
          planId: snapshot.planId,
          origin: snapshot.origin,
          sourceId: snapshot.sourceId,
          sourceHash: snapshot.sourceHash,
          sourceVersion: snapshot.sourceVersion,
          fps: snapshot.fps,
          durationFrames: snapshot.durationFrames,
          clipCount: snapshot.clipCount,
          planJson: JSON.stringify(snapshot.plan),
          planHash: snapshot.planHash,
          createdAt: new Date(input.createdAt),
        },
      })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readByKey(snapshot)
      // Same key, same cut: the caller compiled twice and gets the first
      // answer. Same key, different cut: something other than the source
      // changed the compiler's output, and overwriting the plan somebody
      // already rendered would erase the evidence of what was rendered.
      if (stored && stored.planHash === snapshot.planHash) {
        return Object.freeze({ snapshot: stored, replayed: true })
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `A different plan is already stored for ${snapshot.origin} ${snapshot.sourceId} at that hash`,
        { sourceId: snapshot.sourceId, storedPlanHash: stored?.planHash ?? null },
      )
    }
    // Read back rather than handing the caller its own object: the round trip
    // is where a plan that cannot be rehydrated is still cheap to fix.
    const written = await this.readByKey(snapshot)
    if (!written) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `The renderable plan for ${snapshot.sourceId} vanished between write and read`,
      )
    }
    return Object.freeze({ snapshot: written, replayed: false })
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
