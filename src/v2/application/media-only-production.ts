import { assertDomain } from '../domain/errors.ts'
import type { DesiredAction } from '../domain/desired-action.ts'
import type { ProductionBrief } from '../domain/production-brief.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'

export interface MediaOnlyAnalysisRequest { mode: 'media-only'; objective: StrategicObjectiveId; action: DesiredAction; mediaRefs: readonly string[]; assumptions: readonly string[] }
export interface MediaOnlyTreatmentEvidence { mode: 'media-only'; objective: StrategicObjectiveId; confidence: number; assumptions: readonly string[]; observedClaims: readonly string[]; proposedClaims: readonly string[] }

function canonicalStatements(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))])
}

export function createMediaOnlyAnalysis(input: { brief: ProductionBrief; objective: StrategicObjectiveId; action: DesiredAction; mediaRefs: readonly string[] }): Readonly<MediaOnlyAnalysisRequest> {
  assertDomain(!input.brief.ownerInput, 'INVALID_ARGUMENT', 'media-only analysis requires an absent owner briefing')
  const mediaRefs = canonicalStatements(input.mediaRefs)
  assertDomain(mediaRefs.length > 0, 'INVALID_ARGUMENT', 'media-only analysis requires at least one media source')
  return Object.freeze({ mode: 'media-only', objective: input.objective, action: input.action, mediaRefs: Object.freeze(mediaRefs), assumptions: Object.freeze([...input.brief.assumptions, 'treatment-derived-from-observed-media']) })
}

export function inferMediaOnlyTreatment(input: { analysis: MediaOnlyAnalysisRequest; observedClaims?: readonly string[]; proposedClaims?: readonly string[]; perceptionConfidence: number }): Readonly<MediaOnlyTreatmentEvidence> {
  assertDomain(Number.isFinite(input.perceptionConfidence) && input.perceptionConfidence >= 0 && input.perceptionConfidence <= 1, 'INVALID_ARGUMENT', 'perceptionConfidence must be 0-1')
  const observedClaims = canonicalStatements(input.observedClaims ?? [])
  const proposedClaims = canonicalStatements(input.proposedClaims ?? [])
  const unsupported = proposedClaims.filter((claim) => !observedClaims.includes(claim))
  assertDomain(unsupported.length === 0, 'INVALID_ARGUMENT', 'media-only plan cannot introduce unsupported offer or claim', { unsupported })
  return Object.freeze({ mode: 'media-only', objective: input.analysis.objective, confidence: Math.min(.65, input.perceptionConfidence), assumptions: Object.freeze([...new Set([...input.analysis.assumptions, ...(input.perceptionConfidence < .7 ? ['low-perception-confidence'] : [])])]), observedClaims, proposedClaims })
}
