import { assertDomain } from '../domain/errors.ts'
import type { DesiredAction } from '../domain/desired-action.ts'
import type { ProductionBrief } from '../domain/production-brief.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'

export interface MediaOnlyAnalysisRequest { mode: 'media-only'; objective: StrategicObjectiveId; action: DesiredAction; mediaRefs: readonly string[]; assumptions: readonly string[] }
export interface MediaOnlyTreatmentPlan { schemaVersion: 1; mode: 'media-only'; objective: StrategicObjectiveId; confidence: number; assumptions: readonly string[]; observedClaims: readonly string[]; proposedClaims: readonly string[] }

export function createMediaOnlyAnalysis(input: { brief: ProductionBrief; objective: StrategicObjectiveId; action: DesiredAction; mediaRefs: readonly string[] }): Readonly<MediaOnlyAnalysisRequest> {
  assertDomain(!input.brief.ownerInput, 'INVALID_ARGUMENT', 'media-only analysis requires an absent owner briefing')
  const mediaRefs = input.mediaRefs.map((item) => item.trim()).filter(Boolean)
  assertDomain(mediaRefs.length > 0, 'INVALID_ARGUMENT', 'media-only analysis requires at least one media source')
  return Object.freeze({ mode: 'media-only', objective: input.objective, action: input.action, mediaRefs: Object.freeze(mediaRefs), assumptions: Object.freeze([...input.brief.assumptions, 'treatment-derived-from-observed-media']) })
}

export function inferMediaOnlyTreatment(input: { analysis: MediaOnlyAnalysisRequest; observedClaims?: readonly string[]; proposedClaims?: readonly string[]; perceptionConfidence: number }): Readonly<MediaOnlyTreatmentPlan> {
  assertDomain(Number.isFinite(input.perceptionConfidence) && input.perceptionConfidence >= 0 && input.perceptionConfidence <= 1, 'INVALID_ARGUMENT', 'perceptionConfidence must be 0-1')
  const observedClaims = Object.freeze([...(input.observedClaims ?? [])].map((item) => item.trim()).filter(Boolean))
  const proposedClaims = Object.freeze([...(input.proposedClaims ?? [])].map((item) => item.trim()).filter(Boolean))
  const unsupported = proposedClaims.filter((claim) => !observedClaims.includes(claim))
  assertDomain(unsupported.length === 0, 'INVALID_ARGUMENT', 'media-only plan cannot introduce unsupported offer or claim', { unsupported })
  return Object.freeze({ schemaVersion: 1, mode: 'media-only', objective: input.analysis.objective, confidence: Math.min(.65, input.perceptionConfidence), assumptions: Object.freeze([...input.analysis.assumptions, ...(input.perceptionConfidence < .7 ? ['low-perception-confidence'] : [])]), observedClaims, proposedClaims })
}

export function mediaOnlyProductionService(dependencies: { analyze(request: MediaOnlyAnalysisRequest): Promise<{ observedClaims: readonly string[]; confidence: number }>; renderProxy(plan: MediaOnlyTreatmentPlan): Promise<{ artifactId: string; kind: 'proxy' }> }) {
  return async function execute(input: { brief: ProductionBrief; objective: StrategicObjectiveId; action: DesiredAction; mediaRefs: readonly string[] }) {
    const analysis = createMediaOnlyAnalysis(input)
    const perception = await dependencies.analyze(analysis)
    const plan = inferMediaOnlyTreatment({ analysis, observedClaims: perception.observedClaims, proposedClaims: perception.observedClaims, perceptionConfidence: perception.confidence })
    const proxy = await dependencies.renderProxy(plan)
    return Object.freeze({ analysis, plan, proxy: Object.freeze(proxy) })
  }
}
