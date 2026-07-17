import { DomainError } from './errors.ts'
import { STRATEGIC_OBJECTIVES, type StrategicObjectiveId } from './strategic-objective.ts'

export type ProductionMode = 'talking-head' | 'visual-montage'
export interface TreatmentPlan {
  schemaVersion: 1; objective: StrategicObjectiveId; mode: ProductionMode; energy: number; visualDensity: number
  grammar: { primary: 'speaker' | 'b-roll'; shotRhythm: 'measured' | 'dynamic'; subtitleMode: 'support' | 'narrative' }
  patternBreaks: { maxPer30s: number; allowed: readonly ('zoom' | 'insert' | 'cutaway' | 'layout-change')[] }
  proofPolicy: { required: boolean; minimumEvidenceItems: number }; ctaPolicy: { required: boolean; placement: 'none' | 'close' | 'throughout' }
  assumptions: readonly string[]; alternatives: readonly { id: string; difference: string }[]
  decisions: readonly { field: string; evidenceRefs: readonly string[]; reason: string }[]
  provenance: { rubricId: string; rubricVersion: number; policySnapshotId: string; perceptionSummaryId: string }
}

const conversionObjectives = new Set<StrategicObjectiveId>(['lead-generation', 'sale', 'whatsapp', 'booking', 'download'])
const objectiveIds: readonly StrategicObjectiveId[] = STRATEGIC_OBJECTIVES.map((objective) => objective.id)
export function createTreatmentPlan(input: { objective: StrategicObjectiveId; mode: ProductionMode; rubric: { id: string; version: number; proofRequired: boolean }; policy: { snapshotId: string; maxPatternBreaksPer30s: number; forbiddenEffects: readonly string[] }; perception: { summaryId: string; confidence: number; speakerCoverage: number; visualVariety: number } }): Readonly<TreatmentPlan> {
  if (!objectiveIds.includes(input.objective)) throw new DomainError('INVALID_ARGUMENT', 'Unknown strategic objective')
  const conversion = conversionObjectives.has(input.objective)
  const energy = input.objective === 'discovery' ? .82 : input.objective === 'warming' ? .58 : conversion ? .72 : .62
  const visualDensity = input.mode === 'visual-montage' ? .78 : Math.max(.35, Math.min(.7, .45 + input.perception.visualVariety * .2))
  const allowed = (['zoom', 'insert', 'cutaway', 'layout-change'] as const).filter((effect) => !input.policy.forbiddenEffects.includes(effect))
  const assumptions = input.perception.confidence < .7 ? ['Perception coverage is incomplete; risky decisions require review.'] : []
  const plan: TreatmentPlan = { schemaVersion: 1, objective: input.objective, mode: input.mode, energy, visualDensity, grammar: { primary: input.mode === 'talking-head' && input.perception.speakerCoverage >= .5 ? 'speaker' : 'b-roll', shotRhythm: energy >= .75 ? 'dynamic' : 'measured', subtitleMode: input.mode === 'visual-montage' ? 'narrative' : 'support' }, patternBreaks: { maxPer30s: Math.min(input.policy.maxPatternBreaksPer30s, energy >= .75 ? 5 : 3), allowed: Object.freeze(allowed) }, proofPolicy: { required: input.rubric.proofRequired || conversion, minimumEvidenceItems: input.rubric.proofRequired || conversion ? 1 : 0 }, ctaPolicy: { required: conversion, placement: conversion ? 'close' : 'none' }, assumptions: Object.freeze(assumptions), alternatives: Object.freeze([{ id: 'lower-density', difference: 'Reduce visual density by 20% while preserving narrative structure.' }]), decisions: Object.freeze([{ field: 'energy', evidenceRefs: Object.freeze([input.rubric.id]), reason: `Objective ${input.objective} calibrated energy.` }, { field: 'grammar.primary', evidenceRefs: Object.freeze([input.perception.summaryId]), reason: 'Primary visual follows observed speaker coverage and production mode.' }]), provenance: Object.freeze({ rubricId: input.rubric.id, rubricVersion: input.rubric.version, policySnapshotId: input.policy.snapshotId, perceptionSummaryId: input.perception.summaryId }) }
  return validateTreatmentPlan(plan)
}

export function validateTreatmentPlan(plan: TreatmentPlan): Readonly<TreatmentPlan> {
  if (plan.energy < 0 || plan.energy > 1 || plan.visualDensity < 0 || plan.visualDensity > 1) throw new DomainError('INVALID_ARGUMENT', 'Treatment energy and density must be normalized')
  if (!Number.isInteger(plan.patternBreaks.maxPer30s) || plan.patternBreaks.maxPer30s < 0 || plan.patternBreaks.maxPer30s > 8) throw new DomainError('INVALID_ARGUMENT', 'Pattern-break limit is outside deterministic policy')
  if (plan.ctaPolicy.required && plan.ctaPolicy.placement === 'none') throw new DomainError('INVALID_ARGUMENT', 'Required CTA needs a placement')
  if (plan.proofPolicy.required && plan.proofPolicy.minimumEvidenceItems < 1) throw new DomainError('INVALID_ARGUMENT', 'Required proof needs evidence')
  return Object.freeze(plan)
}

export const TREATMENT_GOLDEN_PLANS = Object.freeze(objectiveIds.flatMap((objective) => (['talking-head', 'visual-montage'] as const).map((mode) => createTreatmentPlan({ objective, mode, rubric: { id: `rubric-${objective}`, version: 1, proofRequired: objective === 'sale' }, policy: { snapshotId: 'policy-golden', maxPatternBreaksPer30s: 5, forbiddenEffects: [] }, perception: { summaryId: 'perception-golden', confidence: .95, speakerCoverage: .8, visualVariety: .5 } }))))
