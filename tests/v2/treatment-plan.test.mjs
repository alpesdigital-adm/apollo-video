import test from 'node:test'
import assert from 'node:assert/strict'
import { createTreatmentPlan, TREATMENT_GOLDEN_PLANS, validateTreatmentPlan } from '../../src/v2/domain/treatment-plan.ts'

const input = { objective: 'sale', mode: 'talking-head', rubric: { id: 'rubric-sale', version: 2, proofRequired: true }, policy: { snapshotId: 'policy-7', maxPatternBreaksPer30s: 4, forbiddenEffects: ['zoom'] }, perception: { summaryId: 'p-1', confidence: .6, speakerCoverage: .9, visualVariety: .2 } }
test('T-FR-060 creates a bounded TreatmentPlan from rubric, policy and perception with audit context', () => {
  const plan = createTreatmentPlan(input)
  assert.equal(plan.ctaPolicy.required, true); assert.equal(plan.proofPolicy.required, true); assert.equal(plan.patternBreaks.allowed.includes('zoom'), false)
  assert.equal(plan.assumptions.length, 1); assert.equal(plan.alternatives.length, 1); assert.equal(plan.decisions.length, 2)
  assert.deepEqual(plan.provenance, { rubricId: 'rubric-sale', rubricVersion: 2, policySnapshotId: 'policy-7', perceptionSummaryId: 'p-1' })
})
test('T-FR-060 validates deterministic limits and provides 16 golden objective/mode plans', () => {
  assert.equal(TREATMENT_GOLDEN_PLANS.length, 16)
  assert.equal(new Set(TREATMENT_GOLDEN_PLANS.map((plan) => `${plan.objective}:${plan.mode}`)).size, 16)
  assert.throws(() => validateTreatmentPlan({ ...createTreatmentPlan(input), patternBreaks: { maxPer30s: 9, allowed: [] } }), /limit/)
})
