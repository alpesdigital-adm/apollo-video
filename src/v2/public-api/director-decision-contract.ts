import type { DirectorDecisionLogEntry, DirectorDecisionFrameLineage } from '../domain/director-decision.ts'

export function presentDirectorDecisionSummary(entry: Readonly<DirectorDecisionLogEntry>) {
  return Object.freeze({ id: entry.id, planNodeIds: entry.planNodeIds, decision: entry.decision, summary: entry.summary, confidence: entry.confidence, score: entry.score, cost: entry.cost, actor: entry.actor, createdAt: entry.createdAt, decisionHash: entry.decisionHash })
}

export function presentDirectorDecisionDetail(input: Readonly<{ schemaVersion: 'director-decision-detail/v1'; logHash: string; decision: Readonly<DirectorDecisionLogEntry>; lineage: Readonly<{ status: 'ready'; trace: Readonly<DirectorDecisionFrameLineage> } | { status: 'unavailable'; reason: string }> }>) {
  return Object.freeze({ schemaVersion: input.schemaVersion, logHash: input.logHash, decision: input.decision, lineage: input.lineage })
}
