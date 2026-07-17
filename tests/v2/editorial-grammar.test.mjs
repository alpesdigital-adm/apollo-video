import test from 'node:test'
import assert from 'node:assert/strict'
import { EDITORIAL_TIMELINE_GOLDENS, energyCurve, placeBroll, validateCameraMotions, validateContinuity, validatePatternBreakBudget } from '../../src/v2/domain/editorial-grammar.ts'

test('T-FR-060 places B-roll at semantic conclusions and blocks visual obstruction or invalid duration', () => {
  const window = { id: 'w', startMs: 0, endMs: 9000, conclusionMs: 7000, obstructedRanges: [[3000, 4000]] }
  assert.equal(placeBroll(window, { desiredStartMs: 4500, desiredEndMs: 8500, minDurationMs: 1000, maxDurationMs: 4000 }).exitReason, 'semantic-conclusion')
  assert.throws(() => placeBroll(window, { desiredStartMs: 2500, desiredEndMs: 4500, minDurationMs: 1000, maxDurationMs: 4000 }), /obstruct/)
})
test('T-FR-060 bounds simulated camera movement and builds objective-aware energy by act', () => {
  const motions = validateCameraMotions([{ kind: 'zoom', reason: 'emphasis', startMs: 0, endMs: 1000, amplitude: .08, velocity: .08, cooldownMs: 2000 }, { kind: 'pan', reason: 'reveal', startMs: 3500, endMs: 4500, amplitude: .1, velocity: .1, cooldownMs: 1500 }])
  assert.equal(motions.length, 2)
  assert.equal(energyCurve({ objective: 'conversion', acts: [{ id: 'h', role: 'hook', startMs: 0, endMs: 3000 }, { id: 'b', role: 'body', startMs: 3000, endMs: 9000 }] })[0].energy, .9)
})
test('T-FR-060 budgets pattern breaks and validates six continuity dimensions with golden distributions', () => {
  const policy = { windowMs: 30_000, maxPerWindow: 3, maxSameType: 2, maxSameGroup: 2 }
  assert.equal(validatePatternBreakBudget(EDITORIAL_TIMELINE_GOLDENS.excessive, policy).valid, false)
  assert.equal(validatePatternBreakBudget(EDITORIAL_TIMELINE_GOLDENS.adequate, policy).valid, true)
  const base = { id: 'a', eyeLine: 'left', movement: 'still', position: 'center', colorProfile: 'warm', audioBed: 'room', argumentId: 'arg1' }
  assert.deepEqual(validateContinuity([base, { ...base, id: 'b', eyeLine: 'right', audioBed: 'silent' }]).map((issue) => issue.code), ['CONTINUITY_EYELINE', 'CONTINUITY_AUDIOBED'])
  assert.deepEqual(Object.keys(EDITORIAL_TIMELINE_GOLDENS), ['excessive', 'scarce', 'adequate'])
})
