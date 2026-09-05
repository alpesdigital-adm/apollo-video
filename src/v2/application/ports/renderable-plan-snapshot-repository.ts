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
   * Compiling the same derivation twice is a replay — the same source hash
   * produces the same cut — and returns the stored row without a second write.
   * The same key with a *different* plan is a conflict rather than an
   * overwrite: something other than the source changed the cut, and silently
   * replacing the plan someone already rendered would erase the evidence.
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
