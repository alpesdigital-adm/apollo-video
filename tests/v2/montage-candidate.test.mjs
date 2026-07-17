import test from 'node:test'
import assert from 'node:assert/strict'
import { selectMontageCandidate } from '../../src/v2/application/select-montage-candidate.ts'

const seed = (id, overrides = {}) => ({ id, hookId: `hook-${id}`, blockOrder: ['hook', 'body', 'cta'], assetIds: [`asset-${id}`], patternBreakIds: [`break-${id}`], confidence: .9, hardGateIssues: [], rubricSignals: { clarity: .8, conversion: .7 }, ...overrides })
const rubric = { id: 'r1', weights: { clarity: .5, conversion: .5 } }
test('T-FR-062 hard-gates before scoring/cost, compares on one rubric and keeps inspectable alternatives', () => {
  let scored = 0; let costed = 0
  const result = selectMontageCandidate({ seeds: [seed('bad', { hardGateIssues: ['RIGHTS_BLOCKED'], rubricSignals: { clarity: 1, conversion: 1 } }), seed('a'), seed('b', { rubricSignals: { clarity: .9, conversion: .9 } })], rubric, minimumConfidence: .7, score: (value) => (scored++, value.rubricSignals.clarity), estimateCost: (value) => (costed++, value.assetIds.length) })
  assert.equal(scored, 2); assert.equal(costed, 2); assert.equal(result.winnerId, 'b'); assert.equal(result.candidates.length, 3)
  assert.equal(result.candidates[0].score, null); assert.deepEqual(result.candidates[0].rejectionReasons, ['RIGHTS_BLOCKED'])
  assert.deepEqual(result.diversity, { uniqueHooks: 3, uniqueOrders: 1, uniqueAssetSets: 3, uniquePatternSets: 3 })
})
test('T-FR-062 returns review on tie/low confidence and blocked without eligible candidate', () => {
  assert.equal(selectMontageCandidate({ seeds: [seed('a'), seed('b')], rubric, minimumConfidence: .7 }).reason, 'SCORE_TIE')
  assert.equal(selectMontageCandidate({ seeds: [seed('a', { confidence: .4 })], rubric, minimumConfidence: .7 }).reason, 'LOW_CONFIDENCE')
  const blocked = selectMontageCandidate({ seeds: [seed('x', { hardGateIssues: ['NARRATIVE'] })], rubric, minimumConfidence: .7 })
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.winnerId, null)
})
