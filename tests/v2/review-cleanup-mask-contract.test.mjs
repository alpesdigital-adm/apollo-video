import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCreateReviewCleanupMaskBody, parseRefineReviewCleanupMaskBody } from '../../src/v2/public-api/review-cleanup-mask-contract.ts'
import { parseRequestTransformationJobBody } from '../../src/v2/public-api/transformation-job-contract.ts'

test('T-FR-218 public mask contracts reject unknown fields and preserve normalized geometry', () => {
  const created = parseCreateReviewCleanupMaskBody({ annotationId: 'annotation-mask-one', transformationBriefId: 'brief-mask-one', format: { outputSpecId: 'vertical-output', width: 1080, height: 1920 }, trackingConfidenceBps: 9000 })
  assert.equal(created.format.height, 1920)
  assert.throws(() => parseCreateReviewCleanupMaskBody({ ...created, providerInput: { secret: true } }), /unsupported properties/)
  const refined = parseRefineReviewCleanupMaskBody({
    expectedMaskHash: 'a'.repeat(64), region: { x: 0.1, y: 0.75, width: 0.8, height: 0.15 }, range: { startFrame: 30, endFrame: 60 },
    keyframes: [{ frame: 30, region: { x: 0.1, y: 0.75, width: 0.8, height: 0.15 } }], trackingStatus: 'tracked', trackingConfidenceBps: 8500,
  })
  assert.equal(refined.keyframes.length, 1)
  assert.throws(() => parseRefineReviewCleanupMaskBody({ ...refined, trackingStatus: 'invented' }), /unsupported/)
})

test('T-FR-218 transformation request accepts mask identity but still rejects caller provider payload', () => {
  const request = parseRequestTransformationJobBody({ briefId: 'brief-mask-one', selectionId: 'selection-mask-one', use: 'marketing', market: 'BR', locale: 'pt-BR', maskId: 'mask-reviewed-one', outputSpecId: 'vertical-output' })
  assert.equal(request.maskId, 'mask-reviewed-one')
  assert.throws(() => parseRequestTransformationJobBody({ ...request, providerInput: { prompt: 'override' } }), /unsupported properties/)
})
