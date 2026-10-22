import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPlanHonorsResolution, planMovementPolicyUnder, protectedOpeningSeconds, requestlessEditorialPolicies, resolveEditorialPolicies,
} from '../../src/v2/domain/editorial-policy-resolution.ts'
import { createEditorialRequest } from '../../src/v2/domain/editorial-request.ts'

// ADR-160 F4: movement and opening. Synthetic values only.
const media = { transcriptId: 'transcript-1', transcriptLanguage: 'xx-YY', hasSelectedInsert: false }

test('the opening is a window only where a request names one; silence and "none" have nothing to protect', () => {
  const window = (directives, context = media) => resolveEditorialPolicies(createEditorialRequest({ directives }), context, []).policies.opening
  const silent = window([])
  assert.deepEqual(silent.value, { mode: 'not-applicable' })
  assert.equal(silent.rule, 'minimal-intervention')
  assert.equal(protectedOpeningSeconds(silent), 0)
  const none = window([{ id: 'o', kind: 'opening', value: 'none' }])
  assert.deepEqual(none.value, { mode: 'not-applicable' })
  assert.equal(none.origin, 'request-field')
  const seconds = window([{ id: 'o', kind: 'opening', value: 'protect-seconds', param: 2.5 }])
  assert.deepEqual(seconds.value, { mode: 'protected-window', seconds: 2.5 })
  assert.equal(seconds.rule, 'explicit-request')
  const sentence = window([{ id: 'o', kind: 'opening', value: 'protect-first-sentence' }], { ...media, firstSentenceEndSeconds: 3.2 })
  assert.deepEqual(sentence.value, { mode: 'protected-window', seconds: 3.2 })
  const unknown = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'o', kind: 'opening', value: 'protect-first-sentence' }] }), media, [])
  assert.deepEqual(unknown.openQuestions.map((item) => item.id), ['opening-first-sentence-unknown'])
  assert.equal(unknown.blocked, true)
})

test('a movement the renderer does not execute is understood, listed and blocks the plan; the plan envelope is exactly what the policies say', () => {
  for (const movement of ['punch-in', 'zoom-in', 'zoom-out', 'pan', 'tilt', 'parallax']) {
    const resolution = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'm', kind: 'movement', value: movement }] }), media, [])
    assert.equal(resolution.blocked, true, movement)
    assert.equal(resolution.policies.movement.status, 'unsupported', movement)
    assert.deepEqual(resolution.unsupported.map((item) => [item.policyKey, item.reason]), [['movement', 'not-executable']], movement)
    assert.throws(() => planMovementPolicyUnder(resolution.policies, 30), (error) => error.code === 'PRECONDITION_REQUIRED')
  }
  const silent = resolveEditorialPolicies(createEditorialRequest({}), media, []).policies
  assert.deepEqual({ ...planMovementPolicyUnder(silent, 30) }, { automaticZoom: false, protectedOpeningFrames: 0 })
  const protectedWindow = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'o', kind: 'opening', value: 'protect-seconds', param: 2 }] }), media, []).policies
  assert.deepEqual({ ...planMovementPolicyUnder(protectedWindow, 30) }, { automaticZoom: false, protectedOpeningFrames: 60 })
  assert.deepEqual({ ...planMovementPolicyUnder(requestlessEditorialPolicies(), 24) }, { automaticZoom: false, protectedOpeningFrames: 0 })
})

test('assertPlanHonorsResolution: a worker judges the plan against its resolution, and refuses what the renderer cannot execute whatever the resolution', () => {
  const resolution = resolveEditorialPolicies(createEditorialRequest({}), media, [])
  const plan = (overrides = {}) => ({ fps: 30, movementPolicy: { automaticZoom: false, protectedOpeningFrames: 0 }, effectTracks: [], ...overrides })
  const refused = (error) => error.code === 'INVALID_RENDER_INPUT'
  assert.doesNotThrow(() => assertPlanHonorsResolution(plan(), resolution))
  assert.doesNotThrow(() => assertPlanHonorsResolution(plan(), null), 'a plan no Director made is judged by what it declares')
  assert.doesNotThrow(() => assertPlanHonorsResolution(plan({ movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 } }), null))
  assert.throws(() => assertPlanHonorsResolution(plan({ movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 } }), resolution), refused)
  assert.throws(() => assertPlanHonorsResolution(plan({ movementPolicy: { automaticZoom: true, protectedOpeningFrames: 0 } }), resolution), refused)
  assert.throws(() => assertPlanHonorsResolution(plan({ effectTracks: [{}] }), null), refused)
  const asked = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'o', kind: 'opening', value: 'protect-seconds', param: 2 }] }), media, [])
  assert.doesNotThrow(() => assertPlanHonorsResolution(plan({ movementPolicy: { automaticZoom: false, protectedOpeningFrames: 60 } }), asked))
  assert.throws(() => assertPlanHonorsResolution(plan(), asked), refused)
  const blocked = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'm', kind: 'movement', value: 'pan' }] }), media, [])
  assert.throws(() => assertPlanHonorsResolution(plan(), blocked), refused)
})
