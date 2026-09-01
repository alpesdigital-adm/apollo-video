import type { NoveltyBudgetDecision, NoveltyBudgetPolicy } from '../../domain/novelty-budget.ts'

export interface NoveltyBudgetRepository {
  persistPolicy(input: {
    policy: Readonly<NoveltyBudgetPolicy>
    workspaceId: string
    createdAt: string
  }): Promise<Readonly<{ policy: Readonly<NoveltyBudgetPolicy>; replayed: boolean }>>

  persistDecision(input: {
    decision: Readonly<NoveltyBudgetDecision>
    createdAt: string
  }): Promise<Readonly<{ decision: Readonly<NoveltyBudgetDecision>; replayed: boolean }>>

  readDecision(input: {
    workspaceId: string
    projectId: string
    decisionId: string
  }): Promise<Readonly<NoveltyBudgetDecision> | null>

  /**
   * The submission gate's only question: does a persisted decision for this
   * exact project version admit this brief?
   *
   * Returns the line, so a refusal can quote the reason the policy gave rather
   * than inventing one at the boundary.
   */
  findBriefVerdict(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    briefId: string
  }): Promise<Readonly<{
    decisionId: string
    decisionHash: string
    policyId: string
    outcome: 'accepted' | 'penalized' | 'blocked'
    chargedUnits: number
    densityUnits: number
    reason: string
    blockedBecause?: string
  }> | null>

  listDecisions(input: {
    workspaceId: string
    projectId: string
    limit?: number
  }): Promise<readonly Readonly<NoveltyBudgetDecision>[]>
}
