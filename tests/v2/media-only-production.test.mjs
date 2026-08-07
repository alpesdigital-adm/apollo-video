import assert from 'node:assert/strict'
import test from 'node:test'

import { createMediaOnlyAnalysis, inferMediaOnlyTreatment } from '../../src/v2/application/media-only-production.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'

test('media-only analysis requires absent briefing and canonical media evidence', () => {
  const input = { brief: createProductionBrief({}), objective: 'discovery', action: createDesiredAction({ objective: 'discovery' }), mediaRefs: [' artifact:raw-video-1 ', 'artifact:raw-video-1'] }
  const analysis = createMediaOnlyAnalysis(input)
  assert.deepEqual(analysis.mediaRefs, ['artifact:raw-video-1'])
  const plan = inferMediaOnlyTreatment({ analysis, observedClaims: ['reduz  retrabalho'], proposedClaims: ['reduz retrabalho'], perceptionConfidence: .82 })
  assert.equal(plan.confidence, .65)
  assert.ok(plan.assumptions.includes('briefing-absent'))
  assert.throws(() => createMediaOnlyAnalysis({ ...input, brief: createProductionBrief({ ownerText: 'Tom direto.' }) }), /absent owner briefing/)
  assert.throws(() => createMediaOnlyAnalysis({ ...input, mediaRefs: [' '] }), /at least one media source/)
})

test('media-only treatment blocks unsupported offer and claim', () => {
  const analysis = { mode: 'media-only', objective: 'sale', action: createDesiredAction({ objective: 'sale', desiredAction: { destination: { type: 'url', value: 'https://checkout.test' } } }), mediaRefs: ['artifact:1'], assumptions: [] }
  assert.throws(() => inferMediaOnlyTreatment({ analysis, observedClaims: ['garantia de 7 dias'], proposedClaims: ['resultado garantido'], perceptionConfidence: .9 }), /unsupported offer or claim/)
})
