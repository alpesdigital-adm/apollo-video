import { createHash } from 'node:crypto'
import { assertDomain } from './errors.ts'
import { STRATEGIC_OBJECTIVES, type StrategicObjectiveId } from './strategic-objective.ts'

export type RubricCriterionId = 'hook-clarity' | 'problem-recognition' | 'trust-building' | 'offer-clarity' | 'proof-strength' | 'cta-clarity' | 'friction-reduction' | 'narrative-integrity' | 'legibility' | 'rights-compliance'
export interface RubricCriterion { id: RubricCriterionId; weight: number; description: string }
export interface StrategicRubric { id: string; version: 1; objective: StrategicObjectiveId; threshold: number; purpose: 'editorial-quality-proxy'; criteria: readonly RubricCriterion[]; requiredGates: readonly ('narrative-integrity' | 'legibility' | 'rights-compliance' | 'cta-required')[] }

const descriptions: Record<RubricCriterionId, string> = {
  'hook-clarity': 'A abertura torna a promessa editorial compreensível.',
  'problem-recognition': 'O público consegue reconhecer o problema ou oportunidade.',
  'trust-building': 'O material cria familiaridade sem fabricar autoridade.',
  'offer-clarity': 'A oferta e seus limites são compreensíveis.',
  'proof-strength': 'Provas permanecem atribuídas e contextualizadas.',
  'cta-clarity': 'A próxima ação é específica e compatível com o objetivo.',
  'friction-reduction': 'O caminho até a ação não introduz ambiguidade evitável.',
  'narrative-integrity': 'Cortes preservam sentido, qualificadores e causalidade.',
  legibility: 'Texto e elementos essenciais permanecem legíveis.',
  'rights-compliance': 'Todos os materiais possuem direitos e consentimentos válidos.',
}

const weights: Record<StrategicObjectiveId, Partial<Record<RubricCriterionId, number>>> = {
  discovery: { 'hook-clarity': .35, 'problem-recognition': .25, 'trust-building': .10, 'narrative-integrity': .15, legibility: .10, 'rights-compliance': .05 },
  awareness: { 'hook-clarity': .20, 'problem-recognition': .35, 'trust-building': .15, 'narrative-integrity': .15, legibility: .10, 'rights-compliance': .05 },
  warming: { 'hook-clarity': .15, 'problem-recognition': .15, 'trust-building': .35, 'proof-strength': .15, 'narrative-integrity': .10, legibility: .05, 'rights-compliance': .05 },
  'lead-generation': { 'hook-clarity': .10, 'offer-clarity': .25, 'proof-strength': .15, 'cta-clarity': .25, 'friction-reduction': .10, 'narrative-integrity': .05, legibility: .05, 'rights-compliance': .05 },
  sale: { 'offer-clarity': .25, 'proof-strength': .25, 'cta-clarity': .20, 'friction-reduction': .10, 'trust-building': .05, 'narrative-integrity': .05, legibility: .05, 'rights-compliance': .05 },
  whatsapp: { 'offer-clarity': .15, 'proof-strength': .10, 'cta-clarity': .30, 'friction-reduction': .20, 'trust-building': .10, 'narrative-integrity': .05, legibility: .05, 'rights-compliance': .05 },
  booking: { 'offer-clarity': .20, 'proof-strength': .10, 'cta-clarity': .25, 'friction-reduction': .20, 'trust-building': .10, 'narrative-integrity': .05, legibility: .05, 'rights-compliance': .05 },
  download: { 'offer-clarity': .25, 'proof-strength': .05, 'cta-clarity': .25, 'friction-reduction': .20, 'problem-recognition': .10, 'narrative-integrity': .05, legibility: .05, 'rights-compliance': .05 },
}

export const STRATEGIC_RUBRICS: readonly StrategicRubric[] = Object.freeze(STRATEGIC_OBJECTIVES.map(({ id, rubricId }) => {
  const criteria = Object.entries(weights[id]).map(([criterionId, weight]) => Object.freeze({ id: criterionId as RubricCriterionId, weight: weight!, description: descriptions[criterionId as RubricCriterionId] }))
  const requiredGates: StrategicRubric['requiredGates'] = ['narrative-integrity', 'legibility', 'rights-compliance', ...(['lead-generation', 'sale', 'whatsapp', 'booking', 'download'].includes(id) ? ['cta-required' as const] : [])]
  return Object.freeze({ id: rubricId, version: 1 as const, objective: id, threshold: id === 'sale' ? 78 : id === 'discovery' ? 68 : 72, purpose: 'editorial-quality-proxy' as const, criteria: Object.freeze(criteria), requiredGates: Object.freeze(requiredGates) })
}))

export function resolveStrategicRubric(objective: StrategicObjectiveId): StrategicRubric {
  return STRATEGIC_RUBRICS.find((rubric) => rubric.objective === objective)!
}

export interface QualityEvidence { criterionId: RubricCriterionId; score: number; evidence: readonly string[] }
export interface QualityReport { schemaVersion: 1; rubric: { id: string; version: number; objective: StrategicObjectiveId; purpose: 'editorial-quality-proxy' }; score: number; passed: boolean; gateFailures: readonly string[]; evidence: readonly QualityEvidence[]; evaluatedAt: string }

export function createQualityReport(input: { objective: StrategicObjectiveId; evidence: readonly QualityEvidence[]; gates: { narrativeIntegrity: boolean; legibility: boolean; rights: boolean; ctaPresent?: boolean }; evaluatedAt: string }): Readonly<QualityReport> {
  const rubric = resolveStrategicRubric(input.objective)
  const evidence = rubric.criteria.map((criterion) => {
    const value = input.evidence.find((candidate) => candidate.criterionId === criterion.id)
    assertDomain(value && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100, 'INVALID_ARGUMENT', `Missing or invalid score for ${criterion.id}`)
    return Object.freeze({ ...value, evidence: Object.freeze([...value.evidence]) })
  })
  const gateFailures = [!input.gates.narrativeIntegrity ? 'narrative-integrity' : '', !input.gates.legibility ? 'legibility' : '', !input.gates.rights ? 'rights-compliance' : '', rubric.requiredGates.includes('cta-required') && !input.gates.ctaPresent ? 'cta-required' : ''].filter(Boolean)
  const score = Math.round(evidence.reduce((sum, item) => sum + item.score * rubric.criteria.find((criterion) => criterion.id === item.criterionId)!.weight, 0) * 100) / 100
  return Object.freeze({ schemaVersion: 1, rubric: Object.freeze({ id: rubric.id, version: rubric.version, objective: rubric.objective, purpose: rubric.purpose }), score, passed: gateFailures.length === 0 && score >= rubric.threshold, gateFailures: Object.freeze(gateFailures), evidence: Object.freeze(evidence), evaluatedAt: new Date(input.evaluatedAt).toISOString() })
}

export function qualityReportSnapshot(report: QualityReport) {
  const contentJson = JSON.stringify(report)
  return Object.freeze({ kind: 'quality-report', schemaVersion: 1, contentJson, contentHash: createHash('sha256').update(contentJson).digest('hex') })
}

export const STRATEGIC_RUBRIC_REFERENCE_SET = Object.freeze(STRATEGIC_OBJECTIVES.flatMap(({ id }) => (['good', 'borderline', 'bad'] as const).map((quality) => Object.freeze({ id: `${id}-${quality}-v1`, objective: id, quality, expectedBand: quality === 'good' ? [80, 100] : quality === 'borderline' ? [60, 79] : [0, 59], note: 'Editorial reference only; it does not assert commercial causality.' }))))
