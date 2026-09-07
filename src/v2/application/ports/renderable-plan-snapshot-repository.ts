import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { RenderablePlanOrigin } from '../renderable-edit-plan.ts'

/**
 * The compiled plan a derivation produced, kept beside the derivation
 * (F4.015, F4.016 condition 6).
 *
 * Why store it at all rather than recompiling on demand: the plan is what was
 * rendered. A gate that reads "the react map was compiled and rendered" has to
 * be able to point at the exact clips the renderer received, and a recompile
 * months later against a moved aggregate would answer a different question.
 *
 * `sourceHash` is what makes staleness visible instead of silent. A playback
 * map that gained an anchor, or a synthesis that was rebuilt, leaves its
 * snapshot naming a hash the head no longer has — so a reader learns the plan
 * describes a cut that no longer exists, rather than rendering it.
 */
export interface RenderablePlanSnapshot {
  readonly workspaceId: string
  readonly projectId: string
  readonly planId: string
  readonly origin: RenderablePlanOrigin
  /** The aggregate that decided the cut: a playback map id, a synthesis id. */
  readonly sourceId: string
  readonly sourceHash: string
  /** The chain position, where the source is versioned. Null where it is not. */
  readonly sourceVersion: number | null
  /**
   * The delivery frame rate. It is the one measurement in this row the request
   * chooses rather than the server measures, and it is part of the natural key
   * `persist` writes under.
   */
  readonly fps: number
  readonly durationFrames: number
  readonly clipCount: number
  readonly plan: Readonly<DirectedEditPlan>
  /** `calculateRenderablePlanHash` — the identity of the cut, not of the row. */
  readonly planHash: string
}

export interface StoredRenderablePlanSnapshot extends RenderablePlanSnapshot {
  readonly createdAt: string
}

export interface RenderablePlanSnapshotRepository {
  /**
   * Store a compiled plan.
   *
   * The natural key is the derivation at its hash, the project version it is
   * compiled into, and the frame rate it is delivered at. Compiling the same
   * derivation twice the same way is a replay — the same source hash at the
   * same rate produces the same cut — and returns the stored row without a
   * second write. Asking for a different delivery rate is a different plan and
   * gets a row of its own: `fps` is the timebase every clip is expressed in, so
   * the two documents are not the same cut and neither one supersedes the
   * other.
   *
   * The same key with a *different* plan is a conflict rather than an
   * overwrite, and now means one thing only: something other than the request
   * changed the cut. Silently replacing the plan someone already rendered would
   * erase the evidence of what was rendered.
   */
  persist(input: {
    snapshot: Readonly<RenderablePlanSnapshot>
    createdAt: string
  }): Promise<Readonly<{ snapshot: Readonly<StoredRenderablePlanSnapshot>; replayed: boolean }>>

  /** The most recently compiled plan for one derivation, whatever its hash. */
  readLatestForSource(input: {
    workspaceId: string
    origin: RenderablePlanOrigin
    sourceId: string
  }): Promise<Readonly<StoredRenderablePlanSnapshot> | null>

  listForProject(input: {
    workspaceId: string
    projectId: string
    origin?: RenderablePlanOrigin
    limit?: number
  }): Promise<readonly Readonly<StoredRenderablePlanSnapshot>[]>
}
