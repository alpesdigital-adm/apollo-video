import { DomainError } from './errors.ts'

export interface DirectorDecision {
  id: string; runId: string; planNodeId: string; commandId: string; artifactId: string; actor: { type: 'agent' | 'human' | 'system'; id: string }
  decision: string; candidates: readonly { id: string; outcome: 'selected' | 'rejected'; reason: string }[]
  evidence: readonly { ref: string; rangeMs?: readonly [number, number] }[]; confidence: number; score: number; cost: { estimated: number; actual: number; currency: 'USD' | 'BRL' | 'credits' }
  summary: string; createdAt: string
}

export function createDirectorDecision(input: DirectorDecision): Readonly<DirectorDecision> {
  for (const [field, value] of Object.entries({ id: input.id, runId: input.runId, planNodeId: input.planNodeId, commandId: input.commandId, artifactId: input.artifactId, decision: input.decision, summary: input.summary, actorId: input.actor.id })) if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `Decision ${field} is required`)
  if (!input.candidates.length || !input.candidates.some((candidate) => candidate.outcome === 'selected')) throw new DomainError('INVALID_ARGUMENT', 'Decision requires candidates and one selection')
  if (!input.evidence.length || input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.score) || input.cost.estimated < 0 || input.cost.actual < 0) throw new DomainError('INVALID_ARGUMENT', 'Decision evidence, confidence, score or cost is invalid')
  if (Number.isNaN(Date.parse(input.createdAt))) throw new DomainError('INVALID_ARGUMENT', 'Decision timestamp is invalid')
  return Object.freeze({ ...input, candidates: Object.freeze(input.candidates.map((candidate) => Object.freeze({ ...candidate }))), evidence: Object.freeze(input.evidence.map((evidence) => Object.freeze({ ...evidence }))), actor: Object.freeze({ ...input.actor }), cost: Object.freeze({ ...input.cost }) })
}

export function traceDecisionToFrames(decision: DirectorDecision, frameMap: readonly { artifactId: string; planNodeId: string; fromFrame: number; toFrame: number }[]) {
  const ranges = frameMap.filter((range) => range.artifactId === decision.artifactId && range.planNodeId === decision.planNodeId)
  if (!ranges.length) throw new DomainError('INVALID_ARGUMENT', 'Decision has no final-frame lineage')
  return Object.freeze({ decisionId: decision.id, runId: decision.runId, commandId: decision.commandId, artifactId: decision.artifactId, frames: Object.freeze(ranges.map((range) => Object.freeze({ from: range.fromFrame, to: range.toFrame }))) })
}
