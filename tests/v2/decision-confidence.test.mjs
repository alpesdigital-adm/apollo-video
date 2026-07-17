import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyConfidence, expectedCalibrationError, relevantUncertainty } from '../../src/v2/domain/decision-confidence.ts'

const confidence = (value) => ({ value, evidence: [{ ref: 'obs_1', weight: 1 }], reasonCodes: ['MODEL_SCORE'], calibrationVersion: 'cal-2026-07' })
test('T-FR-052 applies decision-specific auto, review and block bands and only surfaces uncertainty', () => {
  assert.equal(classifyConfidence('transcription', confidence(.95)), 'auto-apply')
  assert.equal(classifyConfidence('narrative-reorder', confidence(.8)), 'review')
  assert.equal(classifyConfidence('rights', confidence(.99)), 'block')
  const visible = relevantUncertainty([{ id: 'safe', label: 'fala', type: 'transcription', confidence: confidence(.99) }, { id: 'cut', label: 'corte', type: 'cut', confidence: confidence(.7) }])
  assert.deepEqual(visible.map((item) => item.id), ['cut'])
})

test('T-FR-052 measures calibration error and preserves evidence/version for regression', () => {
  const samples = [{ predicted: .9, correct: true }, { predicted: .8, correct: false }, { predicted: .2, correct: false }]
  assert.equal(expectedCalibrationError(samples), .366667)
  assert.throws(() => classifyConfidence('cut', { ...confidence(.5), reasonCodes: [] }), /reason codes/)
})
