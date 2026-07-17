import test from 'node:test'
import assert from 'node:assert/strict'
import { STORY_GOLDEN_FIXTURES, validateStoryPlan } from '../../src/v2/domain/story-plan.ts'

test('T-FR-061 models acts, blocks, dependencies, source candidates and duration targets', () => {
  const result = validateStoryPlan(STORY_GOLDEN_FIXTURES.linear)
  assert.equal(result.readyForEditPlan, true); assert.equal(result.estimatedDurationMs, 8000)
  assert.deepEqual(result.plan.acts.map((act) => act.role), ['opening', 'development', 'resolution'])
  assert.deepEqual(result.plan.blocks.find((block) => block.id === 'argument').content, { claimIds: ['claim-1'], qualifierIds: ['qualifier-1'], proofIds: [] })
  assert.deepEqual(result.plan.blocks.find((block) => block.id === 'cta').dependencies, ['proof'])
})
test('T-FR-061 preserves source reference in cold open and validates linear, cold-open and voiceover goldens', () => {
  for (const plan of Object.values(STORY_GOLDEN_FIXTURES)) assert.equal(validateStoryPlan(plan).readyForEditPlan, true)
  const cold = STORY_GOLDEN_FIXTURES.coldOpen.blocks[0]
  assert.equal(cold.presentation, 'cold-open-reference'); assert.equal(cold.sourceRangeId, 'range-proof')
  assert.equal(STORY_GOLDEN_FIXTURES.coldOpen.blocks.filter((block) => block.sourceRangeId === 'range-proof').length, 1)
  assert.throws(() => validateStoryPlan({ ...STORY_GOLDEN_FIXTURES.linear, targetDurationMs: { min: 100, max: 200 } }), /duration/)
})
