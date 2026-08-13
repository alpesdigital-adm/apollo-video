import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyConfidence,
  CONFIDENCE_BAND_POLICY,
  CONFIDENCE_CALIBRATION_GOLDEN,
  createDecisionConfidence,
  evaluateCalibrationRegression,
  expectedCalibrationError,
  relevantUncertainty,
} from '../../src/v2/domain/decision-confidence.ts'
import { projectConfidenceUncertainties } from '../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts'

const confidence = (value, overrides = {}) => createDecisionConfidence({
  value,
  evidence: [{ ref: 'observation-1', weight: 1 }],
  reasonCodes: ['MODEL_SCORE'],
  calibrationVersion: 'director-confidence-2026-08-v1',
  ...overrides,
})

test('T-FR-052 DecisionConfidence canonically requires evidence, reasons and calibration lineage', () => {
  const value = confidence(0.8)
  assert.equal(value.schemaVersion, 'decision-confidence/v1')
  assert.match(value.confidenceHash, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(value.evidence[0]), true)
  assert.throws(() => confidence(0.8, { evidence: [] }), /evidence/i)
  assert.throws(() => confidence(0.8, { evidence: [{ ref: 'one', weight: 0.7 }] }), /sum to one/i)
  assert.throws(() => confidence(0.8, { reasonCodes: ['free text'] }), /reason codes/i)
  assert.throws(() => confidence(Number.NaN), /between zero and one/i)
})

test('T-FR-052 six decision types use versioned bands and rights requires integral certainty', () => {
  assert.equal(CONFIDENCE_BAND_POLICY.schemaVersion, 'confidence-band-policy/v1')
  assert.equal(classifyConfidence('transcription', confidence(0.95)), 'auto-apply')
  assert.equal(classifyConfidence('cut', confidence(0.7)), 'review')
  assert.equal(classifyConfidence('asset-selection', confidence(0.2)), 'block')
  assert.equal(classifyConfidence('narrative-reorder', confidence(0.8)), 'review')
  assert.equal(classifyConfidence('generation', confidence(0.9)), 'auto-apply')
  assert.equal(classifyConfidence('rights', confidence(0.999999)), 'block')
  assert.equal(classifyConfidence('rights', confidence(1)), 'auto-apply')
})

test('T-FR-052 relevant uncertainty returns only review/block in deterministic priority order', () => {
  const visible = relevantUncertainty([
    { id: 'safe', label: 'fala', type: 'transcription', confidence: confidence(0.99) },
    { id: 'review', label: 'corte', type: 'cut', confidence: confidence(0.7) },
    { id: 'blocked', label: 'direitos', type: 'rights', confidence: confidence(0.99) },
  ])
  assert.deepEqual(visible.map((item) => [item.id, item.band]), [['review', 'review'], ['blocked', 'block']])
})

test('T-FR-052 deterministic eval fixes ECE, calibration version and regression threshold', () => {
  const result = evaluateCalibrationRegression(CONFIDENCE_CALIBRATION_GOLDEN)
  assert.equal(result.calibrationVersion, 'director-confidence-2026-08-v1')
  assert.equal(result.sampleCount, 10)
  assert.equal(result.ece, 0.173)
  assert.equal(result.passed, true)
  assert.match(result.evaluationHash, /^[a-f0-9]{64}$/)
  assert.equal(expectedCalibrationError(CONFIDENCE_CALIBRATION_GOLDEN.samples, 5), result.ece)
  assert.equal(evaluateCalibrationRegression({ ...CONFIDENCE_CALIBRATION_GOLDEN, maximumEce: 0.17 }).passed, false)
})

test('T-FR-052 persisted Director projection is fail-closed and omits auto-apply decisions', () => {
  const review = confidence(0.7)
  const automatic = confidence(0.95)
  const values = [
    { id: 'decision-safe', choice: 'safe-cut', decisionType: 'cut', confidenceDetail: automatic, confidenceBand: 'auto-apply' },
    { id: 'decision-review', choice: 'review-cut', decisionType: 'cut', confidenceDetail: review, confidenceBand: 'review' },
  ]
  assert.deepEqual(projectConfidenceUncertainties(values).map((item) => item.id), ['decision-review'])
  assert.throws(
    () => projectConfidenceUncertainties([{ ...values[1], confidenceBand: 'block' }]),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => projectConfidenceUncertainties([{ ...values[1], confidenceDetail: { ...review, confidenceHash: 'f'.repeat(64) } }]),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
})
