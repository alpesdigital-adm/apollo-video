import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import { STRATEGIC_OBJECTIVES, type StrategicObjectiveId } from './strategic-objective.ts'

export type RubricCriterionId =
  | 'hook-clarity'
  | 'problem-recognition'
  | 'trust-building'
  | 'offer-clarity'
  | 'proof-strength'
  | 'cta-clarity'
  | 'friction-reduction'
  | 'narrative-integrity'
  | 'legibility'
  | 'rights-compliance'

export type StrategicQualityGateId =
  | 'narrative-integrity'
  | 'legibility'
  | 'rights-compliance'
  | 'cta-required'

export interface RubricCriterion {
  id: RubricCriterionId
  weight: number
  description: string
}

export interface StrategicRubric {
  id: string
  version: 1
  objective: StrategicObjectiveId
  threshold: number
  purpose: 'editorial-quality-proxy'
  criteria: readonly RubricCriterion[]
  requiredGates: readonly StrategicQualityGateId[]
}

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

const thresholds: Readonly<Record<StrategicObjectiveId, number>> = Object.freeze({
  discovery: 68,
  awareness: 72,
  warming: 72,
  'lead-generation': 72,
  sale: 78,
  whatsapp: 72,
  booking: 72,
  download: 72,
})

const conversionObjectives = new Set<StrategicObjectiveId>([
  'lead-generation', 'sale', 'whatsapp', 'booking', 'download',
])

export const STRATEGIC_RUBRICS: readonly StrategicRubric[] = Object.freeze(
  STRATEGIC_OBJECTIVES.map(({ id, rubricId }) => {
    const criteria = Object.entries(weights[id]).map(([criterionId, weight]) =>
      Object.freeze({
        id: criterionId as RubricCriterionId,
        weight: weight!,
        description: descriptions[criterionId as RubricCriterionId],
      }))
    const requiredGates: StrategicQualityGateId[] = [
      'narrative-integrity',
      'legibility',
      'rights-compliance',
      ...(conversionObjectives.has(id) ? ['cta-required' as const] : []),
    ]
    assertDomain(
      Math.abs(criteria.reduce((sum, criterion) => sum + criterion.weight, 0) - 1) < 1e-9,
      'PERSISTENCE_CONFLICT',
      `Strategic rubric ${rubricId}/v1 weights are not normalized`,
    )
    return Object.freeze({
      id: rubricId,
      version: 1 as const,
      objective: id,
      threshold: thresholds[id],
      purpose: 'editorial-quality-proxy' as const,
      criteria: Object.freeze(criteria),
      requiredGates: Object.freeze(requiredGates),
    })
  }),
)

export function resolveStrategicRubric(objective: StrategicObjectiveId): StrategicRubric {
  const rubric = STRATEGIC_RUBRICS.find((candidate) => candidate.objective === objective)
  assertDomain(rubric, 'PERSISTENCE_CONFLICT', 'Strategic rubric is not registered', { objective })
  return rubric
}

export interface QualityEvidence {
  criterionId: RubricCriterionId
  score: number
  evidence: readonly string[]
}

export interface StrategicQualityGateResult {
  id: StrategicQualityGateId
  passed: boolean
  evidence: readonly string[]
}

export interface QualityReport {
  schemaVersion: 'strategic-quality-report/v1'
  rubric: Readonly<{
    id: string
    version: number
    objective: StrategicObjectiveId
    purpose: 'editorial-quality-proxy'
    threshold: number
    requiredGates: readonly StrategicQualityGateId[]
  }>
  score: number
  passed: boolean
  gateResults: readonly Readonly<StrategicQualityGateResult>[]
  gateFailures: readonly StrategicQualityGateId[]
  evidence: readonly Readonly<QualityEvidence & { weight: number }>[]
  evaluatedAt: string
}

function qualityEvidence(
  rubric: StrategicRubric,
  values: readonly QualityEvidence[],
): readonly Readonly<QualityEvidence & { weight: number }>[] {
  assertDomain(
    values.length === rubric.criteria.length &&
      new Set(values.map((item) => item.criterionId)).size === values.length,
    'INVALID_ARGUMENT',
    'Quality evidence must contain every rubric criterion exactly once',
  )
  return Object.freeze(rubric.criteria.map((criterion) => {
    const value = values.find((candidate) => candidate.criterionId === criterion.id)
    assertDomain(
      value && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100,
      'INVALID_ARGUMENT',
      `Missing or invalid score for ${criterion.id}`,
    )
    assertDomain(
      value.evidence.length >= 1 && value.evidence.length <= 20 &&
        value.evidence.every((item) => item.trim().length >= 1 && item.length <= 500),
      'INVALID_ARGUMENT',
      `Missing or invalid evidence for ${criterion.id}`,
    )
    return Object.freeze({
      criterionId: criterion.id,
      score: value.score,
      weight: criterion.weight,
      evidence: Object.freeze(value.evidence.map((item) => item.trim())),
    })
  }))
}

export function createQualityReport(input: {
  objective: StrategicObjectiveId
  evidence: readonly QualityEvidence[]
  gates: Readonly<{
    narrativeIntegrity: boolean
    legibility: boolean
    rights: boolean
    ctaPresent?: boolean
  }>
  gateEvidence?: Partial<Record<StrategicQualityGateId, readonly string[]>>
  evaluatedAt: string
}): Readonly<QualityReport> {
  const rubric = resolveStrategicRubric(input.objective)
  const evidence = qualityEvidence(rubric, input.evidence)
  const gateState: Record<StrategicQualityGateId, boolean> = {
    'narrative-integrity': input.gates.narrativeIntegrity,
    legibility: input.gates.legibility,
    'rights-compliance': input.gates.rights,
    'cta-required': !rubric.requiredGates.includes('cta-required') || input.gates.ctaPresent === true,
  }
  const gateResults = Object.freeze(rubric.requiredGates.map((id) => {
    const supportingEvidence = input.gateEvidence?.[id] ?? [`gate:${id}:${gateState[id] ? 'pass' : 'fail'}`]
    assertDomain(
      supportingEvidence.length >= 1 && supportingEvidence.length <= 20 &&
        supportingEvidence.every((item) => item.trim().length >= 1 && item.length <= 500),
      'INVALID_ARGUMENT',
      `Missing or invalid gate evidence for ${id}`,
    )
    return Object.freeze({
      id,
      passed: gateState[id],
      evidence: Object.freeze(supportingEvidence.map((item) => item.trim())),
    })
  }))
  const gateFailures = Object.freeze(
    gateResults.filter((result) => !result.passed).map((result) => result.id),
  )
  const score = Math.round(evidence.reduce(
    (sum, item) => sum + item.score * item.weight,
    0,
  ) * 100) / 100
  const evaluatedAt = new Date(input.evaluatedAt)
  assertDomain(!Number.isNaN(evaluatedAt.getTime()), 'INVALID_ARGUMENT', 'evaluatedAt is invalid')
  return Object.freeze({
    schemaVersion: 'strategic-quality-report/v1' as const,
    rubric: Object.freeze({
      id: rubric.id,
      version: rubric.version,
      objective: rubric.objective,
      purpose: rubric.purpose,
      threshold: rubric.threshold,
      requiredGates: rubric.requiredGates,
    }),
    score,
    passed: gateFailures.length === 0 && score >= rubric.threshold,
    gateResults,
    gateFailures,
    evidence,
    evaluatedAt: evaluatedAt.toISOString(),
  })
}

export function qualityReportSnapshot(report: QualityReport) {
  const contentJson = stableSerialize(report)
  return Object.freeze({
    kind: 'quality-report',
    schemaVersion: 1,
    contentJson,
    contentHash: calculateCanonicalHash(report),
  })
}

export function parseStrategicQualityReport(value: unknown): Readonly<QualityReport> {
  try {
    assertDomain(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      'PERSISTENCE_CONFLICT',
      'Stored strategic quality report is invalid',
    )
    const record = value as Record<string, unknown>
    const rubricRecord = record.rubric as Record<string, unknown> | undefined
    assertDomain(
      record.schemaVersion === 'strategic-quality-report/v1' &&
        rubricRecord && typeof rubricRecord.objective === 'string' &&
        STRATEGIC_OBJECTIVES.some((objective) => objective.id === rubricRecord.objective) &&
        Array.isArray(record.evidence) && Array.isArray(record.gateResults) &&
        typeof record.evaluatedAt === 'string',
      'PERSISTENCE_CONFLICT',
      'Stored strategic quality report is invalid',
    )
    const objective = rubricRecord.objective as StrategicObjectiveId
    const evidence = record.evidence.map((candidate) => {
      assertDomain(
        typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate),
        'PERSISTENCE_CONFLICT',
        'Stored strategic quality evidence is invalid',
      )
      const item = candidate as Record<string, unknown>
      return {
        criterionId: item.criterionId as RubricCriterionId,
        score: item.score as number,
        evidence: item.evidence as string[],
      }
    })
    const gateResults = record.gateResults.map((candidate) => {
      assertDomain(
        typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate),
        'PERSISTENCE_CONFLICT',
        'Stored strategic quality gate is invalid',
      )
      return candidate as Record<string, unknown>
    })
    const gate = (id: StrategicQualityGateId) => gateResults.find((item) => item.id === id)
    const rebuilt = createQualityReport({
      objective,
      evidence,
      gates: {
        narrativeIntegrity: gate('narrative-integrity')?.passed === true,
        legibility: gate('legibility')?.passed === true,
        rights: gate('rights-compliance')?.passed === true,
        ctaPresent: gate('cta-required')?.passed === true,
      },
      gateEvidence: Object.fromEntries(gateResults.map((item) => [
        item.id as StrategicQualityGateId,
        item.evidence as string[],
      ])),
      evaluatedAt: record.evaluatedAt,
    })
    assertDomain(
      stableSerialize(rebuilt) === stableSerialize(value),
      'PERSISTENCE_CONFLICT',
      'Stored strategic quality report is inconsistent',
    )
    return rebuilt
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored strategic quality report is invalid')
  }
}

export interface StrategicRubricReference {
  id: string
  schemaVersion: 'strategic-rubric-reference/v1'
  objective: StrategicObjectiveId
  rubricRef: string
  quality: 'good' | 'borderline' | 'bad'
  expectedBand: readonly [number, number]
  expectedPassed: boolean
  criterionScores: readonly Readonly<QualityEvidence>[]
  gates: Readonly<{
    narrativeIntegrity: boolean
    legibility: boolean
    rights: boolean
    ctaPresent: boolean
  }>
  note: 'Editorial reference only; it does not assert commercial causality.'
}

export const STRATEGIC_RUBRIC_REFERENCE_SET: readonly StrategicRubricReference[] =
  Object.freeze(STRATEGIC_RUBRICS.flatMap((rubric) =>
    (['good', 'borderline', 'bad'] as const).map((quality) => {
      const score = quality === 'good'
        ? Math.max(90, rubric.threshold + 5)
        : quality === 'borderline'
          ? rubric.threshold - 1
          : Math.max(0, rubric.threshold - 30)
      const expectedBand = quality === 'good'
        ? [rubric.threshold, 100] as const
        : quality === 'borderline'
          ? [Math.max(0, rubric.threshold - 10), rubric.threshold - 0.01] as const
          : [0, Math.max(0, rubric.threshold - 10.01)] as const
      return Object.freeze({
        id: `${rubric.objective}-${quality}-v1`,
        schemaVersion: 'strategic-rubric-reference/v1' as const,
        objective: rubric.objective,
        rubricRef: `${rubric.id}/v${rubric.version}`,
        quality,
        expectedBand: Object.freeze(expectedBand),
        expectedPassed: quality === 'good',
        criterionScores: Object.freeze(rubric.criteria.map((criterion) => Object.freeze({
          criterionId: criterion.id,
          score,
          evidence: Object.freeze([`reference:${rubric.objective}:${quality}:${criterion.id}`]),
        }))),
        gates: Object.freeze({
          narrativeIntegrity: quality !== 'bad',
          legibility: quality !== 'bad',
          rights: quality !== 'bad',
          ctaPresent: !rubric.requiredGates.includes('cta-required') || quality !== 'bad',
        }),
        note: 'Editorial reference only; it does not assert commercial causality.' as const,
      })
    }),
  ))
