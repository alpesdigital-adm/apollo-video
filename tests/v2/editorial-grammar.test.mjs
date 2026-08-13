import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EDITORIAL_GRAMMAR_POLICY,
  EDITORIAL_TIMELINE_GOLDENS,
  energyCurve,
  evaluateEditorialGrammar,
  placeBroll,
  validateCameraMotions,
  validateContinuity,
  validatePatternBreakBudget,
} from '../../src/v2/domain/editorial-grammar.ts'

test('T-FR-060 B-roll enters on evidence-bound cues and exits at semantic conclusion', () => {
  const window = {
    id: 'window-proof', startMs: 1_000, endMs: 12_000, conclusionMs: 9_000,
    obstructedRanges: [[4_000, 5_000]],
  }
  const placement = placeBroll(window, {
    id: 'broll-proof', windowId: window.id,
    entryCue: { kind: 'post-setup-pause', atMs: 6_000, evidenceRef: 'pause-evidence-1' },
    desiredDurationMs: 5_000,
  })
  assert.deepEqual(placement, {
    accepted: true, id: 'broll-proof', windowId: 'window-proof', startMs: 6_000, endMs: 9_000,
    entryReason: 'post-setup-pause', entryEvidenceRef: 'pause-evidence-1', exitReason: 'semantic-conclusion',
  })
})

test('T-FR-060 B-roll rejects protected obstruction, short conclusion and duration drift', () => {
  const window = { id: 'window-proof', startMs: 0, endMs: 10_000, conclusionMs: 8_000, obstructedRanges: [[3_000, 4_000]] }
  const request = { id: 'broll-proof', windowId: window.id, entryCue: { kind: 'keyword', atMs: 2_500, evidenceRef: 'word-proof-1' }, desiredDurationMs: 2_000 }
  assert.throws(() => placeBroll(window, request), /BROLL_PROTECTED_RANGE_OBSTRUCTION/)
  assert.throws(() => placeBroll(window, { ...request, entryCue: { ...request.entryCue, atMs: 7_500 } }), /BROLL_SEMANTIC_WINDOW_TOO_SHORT/)
  assert.throws(() => placeBroll(window, { ...request, desiredDurationMs: 8_000 }), /BROLL_DURATION_OUT_OF_BOUNDS/)
})

test('T-FR-060 zoom, pan and tilt require canonical reason, measured velocity and cooldown', () => {
  const motions = validateCameraMotions([
    { id: 'motion-zoom', kind: 'zoom', reason: 'emphasis:Opening promise', evidenceRef: 'word-opening-1', startMs: 0, endMs: 1_000, amplitude: 0.08, velocity: 0.08, cooldownMs: 2_000 },
    { id: 'motion-pan', kind: 'pan', reason: 'reveal:Evidence at frame right', evidenceRef: 'object-proof-2', startMs: 3_000, endMs: 4_000, amplitude: 0.1, velocity: 0.1, cooldownMs: 2_500 },
    { id: 'motion-tilt', kind: 'tilt', reason: 'reframe:Manter espaço do apresentador', evidenceRef: 'face-track-3', startMs: 6_500, endMs: 7_500, amplitude: 0.08, velocity: 0.08, cooldownMs: 2_500 },
  ], 10_000)
  assert.deepEqual(motions.map(({ kind }) => kind), ['zoom', 'pan', 'tilt'])
  assert.throws(() => validateCameraMotions([{ ...motions[0], reason: '', evidenceRef: '' }], 10_000), /MOTION_REASON_EVIDENCE_REQUIRED/)
  assert.throws(() => validateCameraMotions([{ ...motions[0], amplitude: 0.3, velocity: 0.3 }], 10_000), /MOTION_AMPLITUDE_EXCESS/)
  assert.throws(() => validateCameraMotions([{ ...motions[0], endMs: 200, velocity: 0.4 }], 10_000), /MOTION_INSTANTANEOUS/)
  assert.throws(() => validateCameraMotions([motions[0], { ...motions[1], startMs: 2_999, endMs: 3_999 }], 10_000), /MOTION_COOLDOWN_VIOLATION/)
})

test('T-FR-060 energy and density adapt per act and objective while covering the exact timeline', () => {
  const acts = [
    { id: 'act-hook', role: 'hook', startMs: 0, endMs: 3_000 },
    { id: 'act-body', role: 'body', startMs: 3_000, endMs: 10_000 },
    { id: 'act-proof', role: 'proof', startMs: 10_000, endMs: 16_000 },
    { id: 'act-cta', role: 'cta', startMs: 16_000, endMs: 20_000 },
  ]
  const awareness = energyCurve({ objective: 'awareness', acts, durationMs: 20_000 })
  const conversion = energyCurve({ objective: 'conversion', acts, durationMs: 20_000 })
  assert.deepEqual(awareness.map(({ energy }) => energy), [0.82, 0.52, 0.6, 0.58])
  assert.deepEqual(conversion.map(({ energy }) => energy), [0.9, 0.64, 0.76, 0.84])
  assert.ok(conversion.every((act, index) => act.targetBreakDensityPer30s > awareness[index].targetBreakDensityPer30s))
  assert.throws(() => energyCurve({ objective: 'awareness', acts: [{ ...acts[0], endMs: 2_900 }, ...acts.slice(1)], durationMs: 20_000 }), /without gaps or overlaps/)
})

test('T-FR-060 pattern-break budget localizes window, type and semantic-group excess independently', () => {
  const result = validatePatternBreakBudget(EDITORIAL_TIMELINE_GOLDENS.excessive.patternBreaks, { objective: 'awareness', durationMs: 30_000 })
  assert.equal(result.distribution, 'excessive')
  assert.deepEqual(result.issues.map(({ code }) => code), ['PATTERN_WINDOW_EXCESS', 'PATTERN_TYPE_EXCESS', 'PATTERN_GROUP_EXCESS'])
  assert.deepEqual(result.issues[0].subjectIds, ['break-01', 'break-02', 'break-03', 'break-04', 'break-05'])
})

test('T-FR-060 six continuity dimensions report adjacent changes unless evidence justifies them', () => {
  const base = { id: 'frame-a', atMs: 0, eyeLine: 'camera-left', movement: 'still-frame', position: 'center-frame', color: 'neutral-5600k', audio: 'room-tone-a', argument: 'argument-a', justifiedChanges: [], evidenceRefs: [] }
  const changed = { id: 'frame-b', atMs: 2_000, eyeLine: 'camera-right', movement: 'walk-right', position: 'right-third', color: 'warm-4200k', audio: 'music-bed-b', argument: 'argument-b', justifiedChanges: [], evidenceRefs: [] }
  assert.deepEqual(validateContinuity([base, changed], 3_000).issues.map(({ code }) => code), [
    'CONTINUITY_EYE_LINE', 'CONTINUITY_MOVEMENT', 'CONTINUITY_POSITION', 'CONTINUITY_COLOR', 'CONTINUITY_AUDIO', 'CONTINUITY_ARGUMENT',
  ])
  const justified = { ...changed, justifiedChanges: ['argument', 'audio'], evidenceRefs: ['story-transition-1'] }
  assert.deepEqual(validateContinuity([base, justified], 3_000).issues.map(({ code }) => code), [
    'CONTINUITY_EYE_LINE', 'CONTINUITY_MOVEMENT', 'CONTINUITY_POSITION', 'CONTINUITY_COLOR',
  ])
  assert.throws(() => validateContinuity([base, { ...changed, justifiedChanges: ['audio'], evidenceRefs: [] }], 3_000), /require evidence/)
})

test('T-FR-060 golden timelines prove excess, scarcity and adequate distribution deterministically', () => {
  const evaluations = Object.fromEntries(Object.entries(EDITORIAL_TIMELINE_GOLDENS).map(([name, fixture]) => [name, evaluateEditorialGrammar(fixture)]))
  assert.deepEqual(Object.fromEntries(Object.entries(evaluations).map(([name, value]) => [name, value.distribution])), {
    excessive: 'excessive', scarce: 'scarce', adequate: 'adequate',
  })
  assert.equal(evaluations.excessive.valid, false)
  assert.equal(evaluations.scarce.valid, false)
  assert.equal(evaluations.adequate.valid, true)
  assert.equal(evaluations.adequate.broll[0].placement.exitReason, 'semantic-conclusion')
  assert.match(evaluations.adequate.evaluationHash, /^[a-f0-9]{64}$/)
  assert.equal(evaluateEditorialGrammar(EDITORIAL_TIMELINE_GOLDENS.adequate).evaluationHash, evaluations.adequate.evaluationHash)
  assert.equal(evaluations.adequate.policyVersion, EDITORIAL_GRAMMAR_POLICY.version)
})

test('T-FR-060 evaluation fails closed for unknown policy, overlaps and unknown semantic references', () => {
  const fixture = EDITORIAL_TIMELINE_GOLDENS.adequate
  assert.throws(() => evaluateEditorialGrammar({ ...fixture, policyVersion: 'editorial-grammar-future' }), /policy or objective/)
  assert.throws(() => evaluateEditorialGrammar({ ...fixture, semanticWindows: [...fixture.semanticWindows, { id: 'window-overlap', startMs: 10_000, endMs: 20_000, conclusionMs: 18_000, obstructedRanges: [] }] }), /non-overlapping/)
  assert.throws(() => evaluateEditorialGrammar({ ...fixture, brollRequests: [{ ...fixture.brollRequests[0], windowId: 'window-unknown' }] }), /unknown semantic window/)
})
