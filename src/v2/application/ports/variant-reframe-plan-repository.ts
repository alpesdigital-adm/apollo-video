import type { VariantReframeClip, VariantReframePlanRecordV1 } from '../../domain/variant-reframe-plan.ts'
import type { VariantReframeOverrideV2 } from '../../domain/variant-reframe-overrides.ts'
import type { ReframeRoiSource } from '../../domain/server-reframe-roi.ts'
import type { ReframeSpecFacts } from '../project-reframe-facts.ts'

/** What the planner reads about the project's head Version and one of its outputs. */
export interface VariantReframePlanContext {
  workspaceId: string
  projectId: string
  /** The Version the plan is for: the project's head. */
  version: Readonly<{ id: string; baseHash: string }>
  variantId: string
  spec: ReframeSpecFacts
  timeline: Readonly<{ fps: number; durationFrames: number }>
  source: Readonly<ReframeRoiSource>
  clips: readonly VariantReframeClip[]
  /** The current override of every exact range of this variant (a `reset` head applies nothing). */
  overrideHeads: readonly Readonly<VariantReframeOverrideV2>[]
}

export interface StoredVariantReframePlan {
  id: string
  sequence: number
  projectVersionId: string
  record: Readonly<VariantReframePlanRecordV1>
  createdAt: string
}

export interface VariantReframePlanRepository {
  /** The head Version's context for one stable variant, or null when the project is not found. A variant the State does not carry is a refusal. */
  readContext(input: { workspaceId: string; projectId: string; variantId: string }): Promise<Readonly<VariantReframePlanContext> | null>
  /** The latest record persisted for this Version and variant, or null. */
  readHead(input: { workspaceId: string; projectId: string; projectVersionId: string; variantId: string }): Promise<Readonly<StoredVariantReframePlan> | null>
  /**
   * Persists `record` for the Version as the next in its chain, or answers the row that already holds this very content (the same inputs
   * are the same row). The chain is compare-and-swap: a record that lost the race is read again and replayed or appended after the winner.
   */
  persistOrReplay(input: Readonly<{
    id: string
    workspaceId: string
    projectId: string
    projectVersionId: string
    variantId: string
    record: Readonly<VariantReframePlanRecordV1>
    createdAt: string
  }>): Promise<Readonly<{ stored: Readonly<StoredVariantReframePlan>; replayed: boolean }>>
}
