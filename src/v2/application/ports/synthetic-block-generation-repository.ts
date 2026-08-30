import type { SyntheticBlockGeneration } from '../../domain/synthetic-block-generation.ts'

export interface SyntheticBlockGenerationRepository {
  /** Latest attempt for a block, regardless of status. */
  findEffective(input: {
    workspaceId: string
    blockId: string
  }): Promise<Readonly<SyntheticBlockGeneration> | null>
  /**
   * Generations sharing a cache key in the given statuses, newest first.
   * Approved rows are reuse candidates only: the caller must re-validate
   * artifact availability, rights and consent before any reuse. Pending rows
   * signal an in-flight twin that a duplicate must wait for instead of
   * paying a second provider call.
   */
  findByCacheKey(input: {
    workspaceId: string
    cacheKey: string
    statuses: readonly SyntheticBlockGeneration['status'][]
  }): Promise<readonly Readonly<SyntheticBlockGeneration>[]>
  /**
   * Inserts a new attempt; when `supersedes` is present the previous attempt
   * is atomically marked superseded so a late result can never win again.
   */
  create(input: {
    generation: Readonly<SyntheticBlockGeneration>
    supersedes?: string
  }): Promise<Readonly<SyntheticBlockGeneration>>
  /**
   * Applies a terminal provider outcome to a pending generation. Returns the
   * updated row, or null when the row is no longer pending (already settled
   * or superseded) — the caller must treat that as "outcome discarded".
   */
  settle(input: {
    workspaceId: string
    generationId: string
    status: 'approved' | 'failed'
    audioArtifactId?: string
    alignmentArtifactId?: string
    failureReason?: string
    updatedAt: string
  }): Promise<Readonly<SyntheticBlockGeneration> | null>
  listByPlan(input: {
    workspaceId: string
    planId: string
    statuses?: readonly SyntheticBlockGeneration['status'][]
  }): Promise<readonly Readonly<SyntheticBlockGeneration>[]>
}
