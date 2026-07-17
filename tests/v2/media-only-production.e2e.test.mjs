import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { inferMediaOnlyTreatment, mediaOnlyProductionService } from '../../src/v2/application/media-only-production.ts'

test('media-only journey advances from uploaded media to a proxy with explicit low-confidence assumptions', async () => {
  const journey = mediaOnlyProductionService({
    async analyze(request) { assert.equal(request.mode, 'media-only'); return { observedClaims: ['reduz retrabalho'], confidence: .82 } },
    async renderProxy(plan) { assert.equal(plan.proposedClaims[0], 'reduz retrabalho'); return { artifactId: 'proxy-media-only-1', kind: 'proxy' } },
  })
  const result = await journey({ brief: createProductionBrief({}), objective: 'discovery', action: createDesiredAction({ objective: 'discovery' }), mediaRefs: ['artifact:raw-video-1'] })
  assert.equal(result.proxy.kind, 'proxy')
  assert.equal(result.plan.confidence, .65)
  assert.ok(result.plan.assumptions.includes('briefing-absent'))
})

test('media-only treatment blocks unsupported offer and claim', () => {
  const analysis = { mode: 'media-only', objective: 'sale', action: createDesiredAction({ objective: 'sale', destination: 'https://checkout.test' }), mediaRefs: ['artifact:1'], assumptions: [] }
  assert.throws(() => inferMediaOnlyTreatment({ analysis, observedClaims: ['garantia de 7 dias'], proposedClaims: ['resultado garantido'], perceptionConfidence: .9 }), /unsupported offer or claim/)
})
