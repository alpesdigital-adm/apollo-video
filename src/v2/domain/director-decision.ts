import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import type { DirectorDecision as PlannedDirectorDecision } from './director-run.ts'
import type { StoryPlan } from './story-plan.ts'

export type DirectorDecisionCandidateOutcome = 'selected' | 'rejected'
export type DirectorDecisionActorType = 'api-client' | 'user' | 'system'

export interface DirectorDecisionLogEntry {
  schemaVersion: 'director-decision/v1'
  id: string
  runId: string
  planNodeIds: readonly string[]
  commandId: string
  resultTarget: Readonly<{ projectVersionId: string; artifactRole: 'final-output' }>
  actor: Readonly<{ type: DirectorDecisionActorType; id: string }>
  decision: string
  reason: string
  candidates: readonly Readonly<{ id: string; outcome: DirectorDecisionCandidateOutcome; reason: string }>[]
  evidence: readonly Readonly<{ ref: string; rangeMs?: readonly [number, number] }>[]
  confidence: number
  score: number
  cost: Readonly<{ estimated: number; actual: number; currency: 'credits'; source: 'deterministic-local' }>
  summary: string
  createdAt: string
  decisionHash: string
}

export interface DirectorDecisionLog {
  schemaVersion: 'director-decisions-log/v1'
  workspaceId: string
  projectId: string
  runId: string
  commandId: string
  resultVersionId: string
  entries: readonly Readonly<DirectorDecisionLogEntry>[]
  logHash: string
}

export interface DirectorDecisionFrameLineage {
  schemaVersion: 'director-decision-lineage/v1'
  decisionId: string
  runId: string
  commandId: string
  artifactId: string
  projectVersionId: string
  fps: number
  frameRanges: readonly Readonly<{ fromFrame: number; toFrame: number; rangeMs: readonly [number, number] }>[]
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
function required(value: string, field: string, max = 4_000): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > max) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function id(value: string, field: string): string {
  const normalized = value.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function finiteUnit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

export function createDirectorDecision(input: Omit<DirectorDecisionLogEntry, 'schemaVersion' | 'decisionHash'>): Readonly<DirectorDecisionLogEntry> {
  const core = {
    schemaVersion: 'director-decision/v1' as const,
    id: id(input.id, 'decision.id'),
    runId: id(input.runId, 'decision.runId'),
    planNodeIds: Object.freeze(input.planNodeIds.map((value, index) => id(value, `decision.planNodeIds[${index}]`))),
    commandId: id(input.commandId, 'decision.commandId'),
    resultTarget: Object.freeze({ projectVersionId: id(input.resultTarget.projectVersionId, 'decision.resultTarget.projectVersionId'), artifactRole: input.resultTarget.artifactRole }),
    actor: Object.freeze({ type: input.actor.type, id: id(input.actor.id, 'decision.actor.id') }),
    decision: required(input.decision, 'decision.decision', 500),
    reason: required(input.reason, 'decision.reason'),
    candidates: Object.freeze(input.candidates.map((candidate, index) => Object.freeze({ id: id(candidate.id, `decision.candidates[${index}].id`), outcome: candidate.outcome, reason: required(candidate.reason, `decision.candidates[${index}].reason`) }))),
    evidence: Object.freeze(input.evidence.map((evidence, index) => {
      const rangeMs = evidence.rangeMs
      if (rangeMs && (!Array.isArray(rangeMs) || rangeMs.length !== 2 || !rangeMs.every(Number.isSafeInteger) || rangeMs[0] < 0 || rangeMs[1] <= rangeMs[0])) throw new DomainError('INVALID_ARGUMENT', `decision.evidence[${index}].rangeMs is invalid`)
      return Object.freeze({ ref: required(evidence.ref, `decision.evidence[${index}].ref`, 1_000), ...(rangeMs ? { rangeMs: Object.freeze([rangeMs[0], rangeMs[1]] as const) } : {}) })
    })),
    confidence: finiteUnit(input.confidence, 'decision.confidence'),
    score: finiteUnit(input.score, 'decision.score'),
    cost: Object.freeze({ estimated: input.cost.estimated, actual: input.cost.actual, currency: input.cost.currency, source: input.cost.source }),
    summary: required(input.summary, 'decision.summary', 500),
    createdAt: input.createdAt,
  }
  if (!['api-client', 'user', 'system'].includes(core.actor.type) || core.resultTarget.artifactRole !== 'final-output') throw new DomainError('INVALID_ARGUMENT', 'Decision actor or artifact target is invalid')
  if (core.planNodeIds.length < 1 || new Set(core.planNodeIds).size !== core.planNodeIds.length) throw new DomainError('INVALID_ARGUMENT', 'Decision plan-node references are invalid')
  if (core.candidates.length < 1 || core.candidates.length > 64 || core.candidates.filter((candidate) => candidate.outcome === 'selected').length !== 1 || new Set(core.candidates.map((candidate) => candidate.id)).size !== core.candidates.length) throw new DomainError('INVALID_ARGUMENT', 'Decision requires exactly one selected unique candidate')
  if (core.evidence.length < 1 || core.evidence.length > 128 || new Set(core.evidence.map((item) => item.ref)).size !== core.evidence.length) throw new DomainError('INVALID_ARGUMENT', 'Decision evidence is invalid')
  if (![core.cost.estimated, core.cost.actual].every((value) => Number.isFinite(value) && value >= 0) || core.cost.currency !== 'credits' || core.cost.source !== 'deterministic-local') throw new DomainError('INVALID_ARGUMENT', 'Decision cost is invalid')
  if (Number.isNaN(Date.parse(core.createdAt))) throw new DomainError('INVALID_ARGUMENT', 'Decision timestamp is invalid')
  return Object.freeze({ ...core, decisionHash: calculateCanonicalHash(core) })
}

function planNodesForDecision(decision: PlannedDirectorDecision, storyPlan: Readonly<StoryPlan>): readonly string[] {
  const ordered = storyPlan.acts.flatMap((act) => act.blockIds)
  const development = storyPlan.acts.find((act) => act.role === 'development')?.blockIds ?? []
  const selected = decision.category === 'insert' ? development : ordered
  if (selected.length === 0 || selected.some((nodeId) => !storyPlan.blocks.some((block) => block.id === nodeId))) throw new DomainError('INVALID_COMMAND', `Director decision ${decision.id} has no StoryPlan node`)
  return Object.freeze([...selected])
}

export function createDirectorDecisionLog(input: {
  workspaceId: string
  projectId: string
  runId: string
  commandId: string
  resultVersionId: string
  actor: Readonly<{ type: DirectorDecisionActorType; id: string }>
  storyPlan: Readonly<StoryPlan>
  decisions: readonly Readonly<PlannedDirectorDecision>[]
  createdAt: string
}): Readonly<DirectorDecisionLog> {
  const entries = input.decisions.map((decision) => createDirectorDecision({
    id: decision.id,
    runId: input.runId,
    planNodeIds: planNodesForDecision(decision, input.storyPlan),
    commandId: input.commandId,
    resultTarget: { projectVersionId: input.resultVersionId, artifactRole: 'final-output' },
    actor: input.actor,
    decision: decision.choice,
    reason: decision.reason,
    candidates: [
      { id: decision.choice, outcome: 'selected', reason: decision.reason },
      ...decision.alternatives.filter((alternative) => alternative !== decision.choice).map((alternative) => ({ id: alternative, outcome: 'rejected' as const, reason: 'Not selected by the versioned Director policy.' })),
    ],
    evidence: decision.evidenceRefs.map((ref) => ({ ref })),
    confidence: decision.confidence,
    score: decision.confidence,
    cost: { estimated: 0, actual: 0, currency: 'credits', source: 'deterministic-local' },
    summary: `${decision.choice}: ${decision.reason}`,
    createdAt: input.createdAt,
  }))
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new DomainError('INVALID_COMMAND', 'Director decision log identities must be unique')
  const core = {
    schemaVersion: 'director-decisions-log/v1' as const,
    workspaceId: id(input.workspaceId, 'decisionLog.workspaceId'),
    projectId: id(input.projectId, 'decisionLog.projectId'),
    runId: id(input.runId, 'decisionLog.runId'),
    commandId: id(input.commandId, 'decisionLog.commandId'),
    resultVersionId: id(input.resultVersionId, 'decisionLog.resultVersionId'),
    entries: Object.freeze(entries),
  }
  return Object.freeze({ ...core, logHash: calculateCanonicalHash(core) })
}

export function parseDirectorDecisionLog(value: unknown): Readonly<DirectorDecisionLog> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log is invalid')
  const stored = value as DirectorDecisionLog
  if (stored.schemaVersion !== 'director-decisions-log/v1' || !Array.isArray(stored.entries) || !HASH.test(stored.logHash)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log is invalid')
  const entries = stored.entries.map((entry) => {
    const { schemaVersion: _schemaVersion, decisionHash, ...input } = entry
    const parsed = createDirectorDecision(input)
    if (decisionHash !== parsed.decisionHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision hash is invalid')
    return parsed
  })
  const core = { schemaVersion: stored.schemaVersion, workspaceId: stored.workspaceId, projectId: stored.projectId, runId: stored.runId, commandId: stored.commandId, resultVersionId: stored.resultVersionId, entries: Object.freeze(entries) }
  if (calculateCanonicalHash(core) !== stored.logHash || entries.length === 0) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log hash is invalid')
  return Object.freeze({ ...core, logHash: stored.logHash })
}

function collapseFrames(frames: readonly number[]): readonly Readonly<{ fromFrame: number; toFrame: number }>[] {
  const sorted = [...new Set(frames)].toSorted((left, right) => left - right)
  const ranges: { fromFrame: number; toFrame: number }[] = []
  for (const frame of sorted) {
    const last = ranges.at(-1)
    if (last && last.toFrame === frame) last.toFrame = frame + 1
    else ranges.push({ fromFrame: frame, toFrame: frame + 1 })
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range)))
}

export function traceDecisionToFrames(input: {
  decision: Readonly<DirectorDecisionLogEntry>
  artifactId: string
  projectVersionId: string
  fps: number
  planNodeSourceIds: readonly string[]
  frameMap: readonly Readonly<{ clipId: string; frame: number }>[]
}): Readonly<DirectorDecisionFrameLineage> {
  if (input.decision.resultTarget.projectVersionId !== input.projectVersionId || !Number.isFinite(input.fps) || input.fps <= 0) throw new DomainError('VERSION_CONFLICT', 'Decision lineage target is stale')
  const sourceIds = new Set(input.planNodeSourceIds)
  const ranges = collapseFrames(input.frameMap.filter((item) => sourceIds.has(item.clipId)).map((item) => item.frame))
  if (ranges.length === 0) throw new DomainError('PRECONDITION_REQUIRED', 'Decision has no final-frame lineage')
  return Object.freeze({
    schemaVersion: 'director-decision-lineage/v1',
    decisionId: input.decision.id,
    runId: input.decision.runId,
    commandId: input.decision.commandId,
    artifactId: id(input.artifactId, 'lineage.artifactId'),
    projectVersionId: input.projectVersionId,
    fps: input.fps,
    frameRanges: Object.freeze(ranges.map((range) => Object.freeze({ ...range, rangeMs: Object.freeze([Math.floor(range.fromFrame / input.fps * 1_000), Math.ceil(range.toFrame / input.fps * 1_000)] as const) }))),
  })
}
