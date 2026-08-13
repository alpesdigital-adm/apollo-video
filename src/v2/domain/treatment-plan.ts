import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import { STRATEGIC_OBJECTIVES, type StrategicObjectiveId } from './strategic-objective.ts'

export type ProductionMode = 'talking-head' | 'visual-montage' | 'media-only'
export type TreatmentEffect = 'zoom' | 'insert' | 'cutaway' | 'layout-change'

export interface TreatmentPlanDecision {
  id: string
  field: string
  evidenceRefs: readonly string[]
  reason: string
  confidence: number
  impact: 'low' | 'medium' | 'high'
}

export interface TreatmentPlan {
  schemaVersion: 3
  objective: StrategicObjectiveId
  mode: ProductionMode
  confidence: number
  energy: number
  visualDensity: number
  grammar: {
    primary: 'speaker' | 'b-roll'
    shotRhythm: 'measured' | 'dynamic'
    subtitleMode: 'support' | 'narrative'
  }
  patternBreaks: { maxPer30s: number; allowed: readonly TreatmentEffect[] }
  proofPolicy: { required: boolean; minimumEvidenceItems: number }
  ctaPolicy: { required: boolean; placement: 'none' | 'close' | 'throughout'; maxOccurrences: number }
  budget: { patternBreaksPer30s: number; proofItems: number; ctaOccurrences: number; decisions: number }
  assumptions: readonly string[]
  alternatives: readonly { id: string; difference: string; tradeoff: string }[]
  decisions: readonly TreatmentPlanDecision[]
  claimPolicy: { observedClaims: readonly string[]; proposedClaims: readonly string[] }
  provenance: {
    rubricId: string
    rubricVersion: number
    rubricHash: string
    policySnapshotId: string
    policySchemaVersion: number
    policySnapshotHash: string
    perceptionSummaryId: string
    perceptionSchemaVersion: number
    perceptionSummaryHash: string
  }
}

export interface TreatmentPlanFactoryInput {
  objective: StrategicObjectiveId
  mode: ProductionMode
  rubric: { id: string; version: number; proofRequired: boolean; rubricHash?: string }
  policy: {
    snapshotId: string
    schemaVersion?: number
    snapshotHash?: string
    maxPatternBreaksPer30s: number
    forbiddenEffects: readonly string[]
    maxProofItems?: number
    maxCtaOccurrences?: number
    maxDecisions?: number
  }
  perception: {
    summaryId: string
    schemaVersion?: number
    summaryHash?: string
    confidence: number
    speakerCoverage: number
    visualVariety: number
    evidenceItemCount?: number
    durationMs?: number
  }
  mediaOnly?: {
    confidence: number
    assumptions: readonly string[]
    observedClaims: readonly string[]
    proposedClaims: readonly string[]
  }
}

const conversionObjectives = new Set<StrategicObjectiveId>(['lead-generation', 'sale', 'whatsapp', 'booking', 'download'])
const objectiveIds: readonly StrategicObjectiveId[] = STRATEGIC_OBJECTIVES.map((objective) => objective.id)
const effects = ['zoom', 'insert', 'cutaway', 'layout-change'] as const
const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function finiteRatio(value: number, field: string): number {
  assertDomain(Number.isFinite(value) && value >= 0 && value <= 1, 'INVALID_ARGUMENT', `${field} must be normalized`)
  return value
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  assertDomain(Number.isSafeInteger(value) && value >= minimum && value <= maximum, 'INVALID_ARGUMENT', `${field} is outside deterministic policy`)
  return value
}

function version(value: number | undefined, field: string): number {
  return boundedInteger(value ?? 1, 1, 1_000_000, field)
}

function reference(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function hash(value: string | undefined, fallback: unknown, field: string): string {
  const resolved = value ?? calculateCanonicalHash(fallback)
  assertDomain(SHA256.test(resolved), 'INVALID_ARGUMENT', `${field} is invalid`)
  return resolved
}

function textList(values: readonly string[], field: string, maximum: number): readonly string[] {
  assertDomain(Array.isArray(values) && values.length <= maximum, 'INVALID_ARGUMENT', `${field} is invalid`)
  const normalized = values.map((value) => typeof value === 'string' ? value.trim() : '')
  assertDomain(normalized.every((value) => value.length >= 1 && value.length <= 500), 'INVALID_ARGUMENT', `${field} is invalid`)
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  return Object.freeze(normalized)
}

export function createTreatmentPlan(input: TreatmentPlanFactoryInput): Readonly<TreatmentPlan> {
  if (!objectiveIds.includes(input.objective)) throw new DomainError('INVALID_ARGUMENT', 'Unknown strategic objective')
  if ((input.mode === 'media-only') !== Boolean(input.mediaOnly)) throw new DomainError('INVALID_ARGUMENT', 'Media-only mode requires exact media-only evidence')
  finiteRatio(input.perception.confidence, 'Perception confidence')
  finiteRatio(input.perception.speakerCoverage, 'Speaker coverage')
  finiteRatio(input.perception.visualVariety, 'Visual variety')
  const conversion = conversionObjectives.has(input.objective)
  const energy = input.objective === 'discovery' ? .82 : input.objective === 'warming' ? .58 : conversion ? .72 : .62
  const visualDensity = input.mode === 'visual-montage' ? .78 : Math.max(.35, Math.min(.7, .45 + input.perception.visualVariety * .2))
  const allowed = effects.filter((effect) => !input.policy.forbiddenEffects.includes(effect))
  const assumptions = input.mediaOnly?.assumptions ?? (input.perception.confidence < .7 ? ['Perception coverage is incomplete; risky decisions require review.'] : [])
  const maxPatternBreaks = boundedInteger(input.policy.maxPatternBreaksPer30s, 0, 8, 'Pattern-break budget')
  const maxProofItems = boundedInteger(input.policy.maxProofItems ?? 3, 0, 20, 'Proof budget')
  const maxCtaOccurrences = boundedInteger(input.policy.maxCtaOccurrences ?? 1, 0, 5, 'CTA budget')
  const maxDecisions = boundedInteger(input.policy.maxDecisions ?? 12, 2, 50, 'Decision budget')
  const proofRequired = input.rubric.proofRequired || conversion
  assertDomain(!proofRequired || maxProofItems >= 1, 'INVALID_ARGUMENT', 'Required proof exceeds policy budget')
  assertDomain(!conversion || maxCtaOccurrences >= 1, 'INVALID_ARGUMENT', 'Required CTA exceeds policy budget')
  const rubricVersion = version(input.rubric.version, 'Rubric version')
  const policySchemaVersion = version(input.policy.schemaVersion, 'Policy schema version')
  const perceptionSchemaVersion = version(input.perception.schemaVersion, 'Perception schema version')
  const rubricId = reference(input.rubric.id, 'Rubric id')
  const policySnapshotId = reference(input.policy.snapshotId, 'Policy snapshot id')
  const perceptionSummaryId = reference(input.perception.summaryId, 'Perception summary id')
  const provenance = Object.freeze({
    rubricId,
    rubricVersion,
    rubricHash: hash(input.rubric.rubricHash, { id: rubricId, version: rubricVersion, proofRequired: input.rubric.proofRequired }, 'Rubric hash'),
    policySnapshotId,
    policySchemaVersion,
    policySnapshotHash: hash(input.policy.snapshotHash, { snapshotId: policySnapshotId, schemaVersion: policySchemaVersion, maxPatternBreaks, forbiddenEffects: [...input.policy.forbiddenEffects].toSorted(), maxProofItems, maxCtaOccurrences, maxDecisions }, 'Policy snapshot hash'),
    perceptionSummaryId,
    perceptionSchemaVersion,
    perceptionSummaryHash: hash(input.perception.summaryHash, { summaryId: perceptionSummaryId, schemaVersion: perceptionSchemaVersion, confidence: input.perception.confidence, speakerCoverage: input.perception.speakerCoverage, visualVariety: input.perception.visualVariety, evidenceItemCount: input.perception.evidenceItemCount ?? 0, durationMs: input.perception.durationMs ?? 0 }, 'Perception summary hash'),
  })
  const decisions: readonly TreatmentPlanDecision[] = Object.freeze([
    Object.freeze({ id: 'decision-energy', field: 'energy', evidenceRefs: Object.freeze([rubricId]), reason: `Objective ${input.objective} calibrated energy.`, confidence: input.perception.confidence, impact: 'high' as const }),
    Object.freeze({ id: 'decision-grammar-primary', field: 'grammar.primary', evidenceRefs: Object.freeze([perceptionSummaryId]), reason: 'Primary visual follows observed speaker coverage and production mode.', confidence: input.perception.confidence, impact: 'high' as const }),
    Object.freeze({ id: 'decision-pattern-budget', field: 'patternBreaks', evidenceRefs: Object.freeze([policySnapshotId]), reason: 'Pattern breaks are bounded by the immutable policy snapshot.', confidence: 1, impact: 'medium' as const }),
    Object.freeze({ id: 'decision-proof-cta', field: 'proofPolicy,ctaPolicy', evidenceRefs: Object.freeze([rubricId, policySnapshotId]), reason: 'Proof and CTA requirements follow objective rubric and policy budgets.', confidence: 1, impact: 'high' as const }),
  ])
  assertDomain(decisions.length <= maxDecisions, 'INVALID_ARGUMENT', 'Decision log exceeds policy budget')
  const plan: TreatmentPlan = {
    schemaVersion: 3,
    objective: input.objective,
    mode: input.mode,
    confidence: input.mediaOnly?.confidence ?? input.perception.confidence,
    energy,
    visualDensity,
    grammar: Object.freeze({ primary: input.mode !== 'visual-montage' && input.perception.speakerCoverage >= .5 ? 'speaker' : 'b-roll', shotRhythm: energy >= .75 ? 'dynamic' : 'measured', subtitleMode: input.mode === 'visual-montage' ? 'narrative' : 'support' }),
    patternBreaks: Object.freeze({ maxPer30s: Math.min(maxPatternBreaks, energy >= .75 ? 5 : 3), allowed: Object.freeze(allowed) }),
    proofPolicy: Object.freeze({ required: proofRequired, minimumEvidenceItems: proofRequired ? 1 : 0 }),
    ctaPolicy: Object.freeze({ required: conversion, placement: conversion ? 'close' : 'none', maxOccurrences: conversion ? 1 : 0 }),
    budget: Object.freeze({ patternBreaksPer30s: maxPatternBreaks, proofItems: maxProofItems, ctaOccurrences: maxCtaOccurrences, decisions: maxDecisions }),
    assumptions: textList(assumptions, 'Treatment assumptions', 20),
    alternatives: Object.freeze([{ id: 'lower-density', difference: 'Reduce visual density by 20% while preserving narrative structure.', tradeoff: 'Lower interruption risk at the cost of slower visual pacing.' }]),
    decisions,
    claimPolicy: Object.freeze({ observedClaims: textList(input.mediaOnly?.observedClaims ?? [], 'Observed claims', 100), proposedClaims: textList(input.mediaOnly?.proposedClaims ?? [], 'Proposed claims', 100) }),
    provenance,
  }
  return validateTreatmentPlan(plan)
}

export function validateTreatmentPlan(plan: TreatmentPlan): Readonly<TreatmentPlan> {
  assertDomain(plan.schemaVersion === 3, 'INVALID_ARGUMENT', 'Treatment schema version is invalid')
  assertDomain(objectiveIds.includes(plan.objective), 'INVALID_ARGUMENT', 'Treatment objective is invalid')
  assertDomain(Boolean(plan.claimPolicy) && Array.isArray(plan.claimPolicy.observedClaims) && Array.isArray(plan.claimPolicy.proposedClaims), 'INVALID_ARGUMENT', 'Treatment assumptions and claim policy are invalid')
  finiteRatio(plan.confidence, 'Treatment confidence')
  finiteRatio(plan.energy, 'Treatment energy')
  finiteRatio(plan.visualDensity, 'Treatment density')
  boundedInteger(plan.patternBreaks.maxPer30s, 0, 8, 'Pattern-break limit')
  boundedInteger(plan.budget.patternBreaksPer30s, 0, 8, 'Pattern-break budget')
  boundedInteger(plan.budget.proofItems, 0, 20, 'Proof budget')
  boundedInteger(plan.budget.ctaOccurrences, 0, 5, 'CTA budget')
  boundedInteger(plan.budget.decisions, 2, 50, 'Decision budget')
  assertDomain(plan.patternBreaks.maxPer30s <= plan.budget.patternBreaksPer30s, 'INVALID_ARGUMENT', 'Pattern-break plan exceeds policy budget')
  assertDomain(plan.proofPolicy.minimumEvidenceItems <= plan.budget.proofItems, 'INVALID_ARGUMENT', 'Proof plan exceeds policy budget')
  assertDomain(plan.ctaPolicy.maxOccurrences <= plan.budget.ctaOccurrences, 'INVALID_ARGUMENT', 'CTA plan exceeds policy budget')
  assertDomain(plan.decisions.length >= 2 && plan.decisions.length <= plan.budget.decisions, 'INVALID_ARGUMENT', 'Decision log exceeds policy budget')
  if (plan.ctaPolicy.required && (plan.ctaPolicy.placement === 'none' || plan.ctaPolicy.maxOccurrences < 1)) throw new DomainError('INVALID_ARGUMENT', 'Required CTA needs a placement and budget')
  if (!plan.ctaPolicy.required && (plan.ctaPolicy.placement !== 'none' || plan.ctaPolicy.maxOccurrences !== 0)) throw new DomainError('INVALID_ARGUMENT', 'Optional CTA policy cannot reserve hidden occurrences')
  if (plan.proofPolicy.required && plan.proofPolicy.minimumEvidenceItems < 1) throw new DomainError('INVALID_ARGUMENT', 'Required proof needs evidence')
  assertDomain(plan.patternBreaks.allowed.every((effect) => effects.includes(effect)) && new Set(plan.patternBreaks.allowed).size === plan.patternBreaks.allowed.length, 'INVALID_ARGUMENT', 'Pattern-break effects are invalid')
  textList(plan.assumptions, 'Treatment assumptions', 20)
  textList(plan.claimPolicy.observedClaims, 'Observed claims', 100)
  textList(plan.claimPolicy.proposedClaims, 'Proposed claims', 100)
  assertDomain(plan.alternatives.length >= 1 && plan.alternatives.length <= 10, 'INVALID_ARGUMENT', 'Treatment alternatives are invalid')
  for (const decision of plan.decisions) {
    reference(decision.id, 'Decision id')
    assertDomain(decision.field.trim().length >= 1 && decision.reason.trim().length >= 1 && decision.reason.length <= 500, 'INVALID_ARGUMENT', 'Treatment decision is invalid')
    textList(decision.evidenceRefs, 'Decision evidence', 20)
    finiteRatio(decision.confidence, 'Decision confidence')
    assertDomain(['low', 'medium', 'high'].includes(decision.impact), 'INVALID_ARGUMENT', 'Decision impact is invalid')
  }
  const provenance = plan.provenance
  reference(provenance.rubricId, 'Rubric id')
  reference(provenance.policySnapshotId, 'Policy snapshot id')
  reference(provenance.perceptionSummaryId, 'Perception summary id')
  version(provenance.rubricVersion, 'Rubric version')
  version(provenance.policySchemaVersion, 'Policy schema version')
  version(provenance.perceptionSchemaVersion, 'Perception schema version')
  hash(provenance.rubricHash, {}, 'Rubric hash')
  hash(provenance.policySnapshotHash, {}, 'Policy snapshot hash')
  hash(provenance.perceptionSummaryHash, {}, 'Perception summary hash')
  const unsupportedClaims = plan.claimPolicy.proposedClaims.filter((claim) => !plan.claimPolicy.observedClaims.includes(claim))
  if (unsupportedClaims.length > 0) throw new DomainError('INVALID_ARGUMENT', 'Treatment cannot introduce unsupported offer or claim')
  if (plan.mode === 'media-only' && (plan.confidence > .65 || !plan.assumptions.includes('briefing-absent') || !plan.assumptions.includes('treatment-derived-from-observed-media'))) throw new DomainError('INVALID_ARGUMENT', 'Media-only treatment must remain evidence-bound and confidence-limited')
  if (plan.mode !== 'media-only' && (plan.claimPolicy.observedClaims.length > 0 || plan.claimPolicy.proposedClaims.length > 0)) throw new DomainError('INVALID_ARGUMENT', 'Observed media claims require media-only mode')
  return Object.freeze(plan)
}

export const TREATMENT_GOLDEN_PLANS = Object.freeze(objectiveIds.flatMap((objective) => (['talking-head', 'visual-montage'] as const).map((mode) => createTreatmentPlan({ objective, mode, rubric: { id: `rubric-${objective}`, version: 1, proofRequired: objective === 'sale' }, policy: { snapshotId: 'policy-golden', schemaVersion: 1, maxPatternBreaksPer30s: 5, forbiddenEffects: [], maxProofItems: 3, maxCtaOccurrences: 1, maxDecisions: 12 }, perception: { summaryId: 'perception-golden', schemaVersion: 1, confidence: .95, speakerCoverage: .8, visualVariety: .5, evidenceItemCount: 8, durationMs: 30_000 } }))))
