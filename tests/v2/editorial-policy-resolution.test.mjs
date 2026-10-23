import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EDITORIAL_POLICY_RULES, EDITORIAL_POLICY_RESOLUTION_SCHEMA, POLICY_KEYS, POLICY_ORIGINS,
  assertResolutionPlannable, automaticZoomUnderPolicy, captionTrackId, movementMatchesPolicy, openingMatchesPolicy, parseEditorialPolicyResolution,
  parsePolicyRef, policyRef, protectedOpeningSeconds, resolutionOwnsPolicyRef, resolveEditorialPolicies,
} from '../../src/v2/domain/editorial-policy-resolution.ts'
import { createBriefInterpretation, createEditorialRequest } from '../../src/v2/domain/editorial-request.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'

// Synthetic briefings only: the product holds no phrase of any video. The briefings below say nothing about any real content.
const BRIEFING = 'alpha beta gamma delta epsilon zeta'
const interpreter = { provider: 'test-double', model: 'stub-1', promptVersion: 'p1' }
const excerptOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length, text: needle })
const media = { transcriptId: 'transcript-1', transcriptLanguage: 'xx-YY', hasSelectedInsert: false }
const interpretationOf = (directives, extra = {}) => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives, ...extra })

test('a silent request resolves every policy with an origin, a named rule, a reason and evidence', () => {
  const request = createEditorialRequest({})
  const resolution = resolveEditorialPolicies(request, { hasSelectedInsert: false, transcriptLanguage: 'xx-YY' }, {})
  assert.equal(resolution.schemaVersion, EDITORIAL_POLICY_RESOLUTION_SCHEMA)
  assert.equal(resolution.requestHash, request.requestHash)
  assert.deepEqual(Object.keys(resolution.policies).sort(), [...POLICY_KEYS].sort())
  for (const key of POLICY_KEYS) {
    const policy = resolution.policies[key]
    assert.equal(policy.key, key)
    assert.ok(POLICY_ORIGINS.includes(policy.origin), `${key} origin`)
    assert.ok(EDITORIAL_POLICY_RULES[policy.rule], `${key} names a catalogued rule`)
    assert.ok(EDITORIAL_POLICY_RULES[policy.rule].origins.includes(policy.origin), `${key}: rule ${policy.rule} does not allow origin ${policy.origin}`)
    assert.ok(policy.reason.length > 20, `${key} has a reason`)
    assert.ok(policy.evidenceRefs.length > 0 && policy.evidenceRefs.includes(`request:${request.requestHash}`), `${key} cites the request it was silent on`)
    assert.equal(policy.status, 'applied')
  }
  assert.equal(resolution.blocked, false)
  assert.deepEqual(resolution.unsupported, [])
})

test('the silence rule invents nothing: no movement, no overlay, no insert, no forbidden speech, no CTA requirement', () => {
  const { policies } = resolveEditorialPolicies(createEditorialRequest({}), { hasSelectedInsert: false, transcriptLanguage: 'xx-YY' }, {})
  assert.deepEqual(policies.movement.value, { mode: 'none' })
  assert.equal(policies.movement.origin, 'silence-rule')
  assert.equal(policies.movement.rule, 'minimal-intervention')
  assert.deepEqual(policies.ctaOverlay.value, { mode: 'none' })
  assert.deepEqual(policies.inserts.value, { mode: 'no-insert' })
  assert.deepEqual(policies.speechRemovals.value.ruleIds, [])
  assert.equal(policies.cta.value.required, false)
  assert.equal(policies.transitions.rule, 'minimal-intervention')
  // The reason of the silence says that it is silence; it never attributes a wish to the owner.
  for (const key of ['movement', 'transitions', 'inserts', 'ctaOverlay', 'speechRemovals']) {
    assert.doesNotMatch(policies[key].reason, /owner|requester (wants|wished)|was requested/i, `${key} must not invent an owner intent`)
  }
  assert.match(policies.movement.reason, /does not mention camera movement/)
})

test('no value is carried from the planner of the earlier waves: the rule does not exist and a resolution that names it is refused', () => {
  assert.equal(EDITORIAL_POLICY_RULES['carried-planner-value'], undefined)
  const { policies } = resolveEditorialPolicies(createEditorialRequest({}), { hasSelectedInsert: false, transcriptLanguage: 'xx-YY' }, {})
  for (const key of POLICY_KEYS) assert.notEqual(policies[key].rule, 'carried-planner-value', key)
  assert.deepEqual(policies.structure.value, { order: 'source-order', roles: 'none' })
  assert.equal(policies.structure.rule, 'minimal-intervention')
  const forged = JSON.parse(JSON.stringify(resolveEditorialPolicies(createEditorialRequest({}), { hasSelectedInsert: false, transcriptLanguage: 'xx-YY' }, {})))
  forged.policies.structure.rule = 'carried-planner-value'
  assert.throws(() => parseEditorialPolicyResolution(forged), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('different requests over the same media give different resolutions', () => {
  const none = createEditorialRequest({ directives: [{ id: 'm', kind: 'movement', value: 'none' }] })
  const silent = createEditorialRequest({})
  const language = createEditorialRequest({ directives: [{ id: 'l', kind: 'caption-language', value: 'set', param: 'xx-YY' }] })
  const action = createEditorialRequest({ objective: 'sale', desiredAction: createDesiredAction({ objective: 'sale', desiredAction: { destination: { type: 'url', value: 'https://example.com/x' }, visualCta: 'label' } }) })
  const removal = createEditorialRequest({ requestedRemovals: ['rule-a'] })
  const hashes = new Set()
  for (const request of [silent, none, language, action, removal]) hashes.add(resolveEditorialPolicies(request, media, {}).policyResolutionHash)
  assert.equal(hashes.size, 5, 'five different requests, five different resolutions')

  const a = resolveEditorialPolicies(silent, media, {})
  const b = resolveEditorialPolicies(none, media, {})
  assert.equal(a.policies.movement.origin, 'silence-rule')
  assert.equal(b.policies.movement.origin, 'request-field')
  assert.equal(b.policies.movement.rule, 'explicit-request')
  assert.match(b.policies.movement.reason, /Requested as a structured field/)
  const sale = resolveEditorialPolicies(action, media, {})
  assert.equal(sale.policies.cta.value.required, true)
  assert.equal(sale.policies.cta.rule, 'desired-action')
  // the visual call is drawn where the speech says the call; with none in the speech there is nowhere to draw it, which is a question
  assert.equal(sale.blocked, true)
  assert.deepEqual(sale.openQuestions.map((item) => item.id), ['cta-overlay-placement-unknown'])
  const spoken = resolveEditorialPolicies(action, { ...media, spokenCta: { startSeconds: 4, endSeconds: 6.5 }, timelineDurationSeconds: 9 }, {})
  assert.deepEqual(spoken.policies.ctaOverlay.value, { mode: 'window', startSeconds: 4, endSeconds: 6.5, anchoredTo: 'spoken-cta' })
  assert.equal(spoken.policies.ctaOverlay.origin, 'request-field')
  assert.equal(spoken.blocked, false)
  assert.deepEqual(resolveEditorialPolicies(removal, media, {}).policies.speechRemovals.value.ruleIds, ['rule-a'])
  assert.equal(resolveEditorialPolicies(removal, media, {}).policies.speechRemovals.origin, 'request-field')
})

test('different media over the same request give different resolutions', () => {
  const request = createEditorialRequest({})
  const withInsert = resolveEditorialPolicies(request, { ...media, hasSelectedInsert: true }, {})
  const without = resolveEditorialPolicies(request, media, {})
  assert.equal(withInsert.policies.inserts.origin, 'media-context')
  assert.equal(without.policies.inserts.origin, 'silence-rule')
  assert.notEqual(withInsert.policyResolutionHash, without.policyResolutionHash)
  const english = resolveEditorialPolicies(request, { ...media, transcriptLanguage: 'en-US', transcriptLanguageBasis: 'detected-from-media' }, {})
  assert.deepEqual(english.policies.language.value, { captionLanguage: 'en-US' })
  assert.equal(english.policies.language.origin, 'media-context')
  assert.equal(captionTrackId(english.policies.language), 'track-captions-en-us')
})

test('a briefing directive attributes the policy to the exact words of the briefing', () => {
  const interpretation = interpretationOf([{ id: 'i1', kind: 'movement', value: 'none', excerpt: excerptOf(BRIEFING, 'gamma delta') }])
  const request = createEditorialRequest({ briefing: BRIEFING, interpretation })
  const { policies } = resolveEditorialPolicies(request, media, {})
  assert.equal(policies.movement.origin, 'request-briefing')
  assert.equal(policies.movement.rule, 'explicit-request')
  assert.match(policies.movement.reason, /Requested in the briefing: "gamma delta"/)
  assert.ok(policies.movement.evidenceRefs.includes('directive:i1'))
  assert.ok(policies.movement.evidenceRefs.includes(`briefing:${BRIEFING.indexOf('gamma delta')}-${BRIEFING.indexOf('gamma delta') + 'gamma delta'.length}`))
})

test('a structured field prevails over the briefing, and the resolution says so', () => {
  const interpretation = interpretationOf([{ id: 'i1', kind: 'caption-style', value: 'kinetic', excerpt: excerptOf(BRIEFING, 'beta') }])
  const request = createEditorialRequest({ briefing: BRIEFING, interpretation, directives: [{ id: 'f1', kind: 'caption-style', value: 'clean-color' }] })
  const { policies, blocked } = resolveEditorialPolicies(request, media, {})
  assert.equal(policies.captions.origin, 'request-field')
  assert.equal(policies.captions.value.presetId, 'clean-color')
  assert.match(policies.captions.reason, /briefing also read as caption-style kinetic; the structured field prevails/)
  assert.equal(blocked, false)
})

test('a variant override applies only to its own output', () => {
  const request = createEditorialRequest({ variantOverrides: { 'variant-a': [{ id: 'v1', kind: 'layout', value: 'fit-with-backdrop' }] } })
  const forA = resolveEditorialPolicies(request, media, { variantId: 'variant-a' })
  const forB = resolveEditorialPolicies(request, media, { variantId: 'variant-b' })
  assert.equal(forA.policies.layout.origin, 'request-field')
  assert.match(forA.policies.layout.reason, /output variant variant-a/)
  assert.equal(forB.policies.layout.origin, 'silence-rule')
})

test('a request for something the Apollo cannot execute blocks the plan: it is never ignored', () => {
  const interpretation = interpretationOf([{ id: 'i1', kind: 'movement', value: 'zoom-in', excerpt: excerptOf(BRIEFING, 'delta') }])
  const request = createEditorialRequest({ briefing: BRIEFING, interpretation })
  const resolution = resolveEditorialPolicies(request, media, {})
  assert.equal(resolution.blocked, true)
  assert.equal(resolution.policies.movement.status, 'unsupported')
  assert.equal(resolution.policies.movement.origin, 'request-briefing')
  assert.match(resolution.policies.movement.reason, /cannot execute it/)
  assert.equal(resolution.unsupported.length, 1)
  assert.equal(resolution.unsupported[0].policyKey, 'movement')
  assert.equal(resolution.unsupported[0].reason, 'not-executable')
  assert.throws(() => assertResolutionPlannable(resolution), (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.unsupported.length === 1)
  assert.throws(() => automaticZoomUnderPolicy(resolution.policies.movement), (error) => error.code === 'PRECONDITION_REQUIRED')
  // The same request over a silent policy set is not blocked.
  assert.doesNotThrow(() => assertResolutionPlannable(resolveEditorialPolicies(createEditorialRequest({}), media, {})))
})

test('what the interpreter could not map, and what it asks, blocks until it is answered', () => {
  const interpretation = interpretationOf([], {
    unsupported: [{ id: 'u1', excerpt: excerptOf(BRIEFING, 'epsilon'), summary: 'asks for something the vocabulary lacks', reason: 'outside-vocabulary' }],
    questions: [{ id: 'q1', question: 'Which of the two?', excerpt: excerptOf(BRIEFING, 'zeta'), status: 'open' }],
  })
  const resolution = resolveEditorialPolicies(createEditorialRequest({ briefing: BRIEFING, interpretation }), media, {})
  assert.equal(resolution.blocked, true)
  assert.deepEqual(resolution.unsupported.map((item) => [item.policyKey, item.reason]), [['interpretation', 'outside-vocabulary']])
  assert.deepEqual(resolution.openQuestions.map((item) => item.id), ['q1'])
  const answered = interpretationOf([], { questions: [{ id: 'q1', question: 'Which of the two?', status: 'answered', answer: 'the first' }] })
  assert.equal(resolveEditorialPolicies(createEditorialRequest({ briefing: BRIEFING, interpretation: answered }), media, {}).blocked, false)
})

test('keep and avoid directives are listed as unsupported, not dropped', () => {
  const request = createEditorialRequest({ directives: [{ id: 'k1', kind: 'avoid', value: 'subject', param: 'a subject' }] })
  const resolution = resolveEditorialPolicies(request, media, {})
  assert.equal(resolution.blocked, true)
  assert.equal(resolution.unsupported[0].kind, 'avoid')
})

test('the caption language is the request\'s or the transcript\'s; with neither it is a question, never a guess', () => {
  const silent = createEditorialRequest({})
  const unknown = resolveEditorialPolicies(silent, { hasSelectedInsert: false }, {})
  assert.equal(unknown.policies.language.value.captionLanguage, null)
  assert.equal(unknown.blocked, true)
  assert.deepEqual(unknown.openQuestions.map((item) => item.id), ['caption-language-unknown'])
  const asked = createEditorialRequest({ directives: [{ id: 'l', kind: 'caption-language', value: 'set', param: 'aa-BB' }] })
  const divergent = resolveEditorialPolicies(asked, { ...media, transcriptLanguage: 'cc' }, {})
  assert.equal(divergent.policies.language.origin, 'request-field')
  assert.equal(divergent.blocked, true)
  assert.deepEqual(divergent.openQuestions.map((item) => item.id), ['caption-language-translation'])
  const sameLanguage = resolveEditorialPolicies(asked, { ...media, transcriptLanguage: 'aa-CC' }, {})
  assert.equal(sameLanguage.blocked, false)
})

test('layout follows the geometry of the source and of the output unless the request says otherwise', () => {
  const request = createEditorialRequest({})
  const same = resolveEditorialPolicies(request, { ...media, sourceAspectRatio: '9:16' }, { id: 'out-1', aspectRatio: '9:16' })
  assert.deepEqual(same.policies.layout.value, { mode: 'source-native' })
  assert.equal(same.policies.layout.origin, 'output-spec')
  assert.equal(same.policies.layout.rule, 'output-geometry')
  const different = resolveEditorialPolicies(request, { ...media, sourceAspectRatio: '16:9' }, { id: 'out-1', aspectRatio: '9:16' })
  assert.deepEqual(different.policies.layout.value, { mode: 'fit-with-backdrop' })
  assert.equal(different.policies.layout.origin, 'silence-rule')
  assert.match(different.policies.layout.reason, /16:9/)
  const unknown = resolveEditorialPolicies(request, media, {})
  assert.match(unknown.policies.layout.reason, /no source or output geometry/)
})

test('the resolution is pure and sealed: same inputs, same hash; a changed byte is refused on read', () => {
  const request = createEditorialRequest({ briefing: BRIEFING, objective: 'discovery', requestedRemovals: ['rule-a'] })
  const first = resolveEditorialPolicies(request, media, { aspectRatio: '9:16' })
  const second = resolveEditorialPolicies(request, structuredClone(media), { aspectRatio: '9:16' })
  assert.equal(first.policyResolutionHash, second.policyResolutionHash)
  const stored = JSON.parse(JSON.stringify(first))
  assert.equal(parseEditorialPolicyResolution(stored).policyResolutionHash, first.policyResolutionHash)
  const tampered = JSON.parse(JSON.stringify(first))
  tampered.policies.movement.value.mode = 'zoom-in'
  assert.throws(() => parseEditorialPolicyResolution(tampered), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const wrongOrigin = JSON.parse(JSON.stringify(first))
  wrongOrigin.policies.movement.rule = 'explicit-request'
  assert.throws(() => parseEditorialPolicyResolution(wrongOrigin), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const noEvidence = JSON.parse(JSON.stringify(first))
  noEvidence.policies.cta.evidenceRefs = []
  assert.throws(() => parseEditorialPolicyResolution(noEvidence), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('a decision points at its policy by a reference only that resolution owns', () => {
  const a = resolveEditorialPolicies(createEditorialRequest({}), media, {})
  const b = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'm', kind: 'movement', value: 'none' }] }), media, {})
  const ref = policyRef(a, 'movement')
  assert.match(ref, /^policy:movement:[a-f0-9]{16}$/)
  assert.deepEqual(parsePolicyRef(ref), { key: 'movement', hashPrefix: a.policyResolutionHash.slice(0, 16) })
  assert.equal(resolutionOwnsPolicyRef(a, ref), true)
  assert.equal(resolutionOwnsPolicyRef(b, ref), false)
  assert.equal(parsePolicyRef('policy:nonsense:0000000000000000'), null)
})

test('the plan facts the gates judge: movement none and an opening with no window to protect', () => {
  const { policies } = resolveEditorialPolicies(createEditorialRequest({}), media, {})
  const facts = { fps: 30, automaticZoom: false, protectedOpeningFrames: 0, effectTrackCount: 0 }
  assert.deepEqual(policies.opening.value, { mode: 'not-applicable' })
  assert.equal(movementMatchesPolicy(facts, policies.movement), true)
  assert.equal(openingMatchesPolicy(facts, policies.opening), true)
  assert.equal(movementMatchesPolicy({ ...facts, effectTrackCount: 1 }, policies.movement), false)
  assert.equal(movementMatchesPolicy({ ...facts, automaticZoom: true }, policies.movement), false)
  // a plan that states a window nobody asked for does not state the policy
  assert.equal(openingMatchesPolicy({ ...facts, protectedOpeningFrames: 120 }, policies.opening), false)
  assert.equal(openingMatchesPolicy({ ...facts, effectTrackCount: 2 }, policies.opening), false)
  assert.equal(automaticZoomUnderPolicy(policies.movement), false)
})

test('a language the project declared is never recorded as observed in the media; one the provider detected is', () => {
  const request = createEditorialRequest({})
  const declared = resolveEditorialPolicies(request, { ...media, transcriptLanguage: 'en-US', transcriptLanguageBasis: 'declared-not-verified', declaredLocale: 'en-US' }, {})
  assert.equal(declared.policies.language.origin, 'request-field')
  assert.equal(declared.policies.language.rule, 'explicit-request')
  assert.match(declared.policies.language.reason, /not verified/)
  assert.ok(declared.policies.language.evidenceRefs.includes('transcript-language:declared-not-verified'))
  // a transcript that records no basis is read as declared and not verified, never as an observation
  const unrecorded = resolveEditorialPolicies(request, { ...media, transcriptLanguage: 'en-US' }, {})
  assert.equal(unrecorded.policies.language.origin, 'request-field')
  const detected = resolveEditorialPolicies(request, { ...media, transcriptLanguage: 'en-US', transcriptLanguageBasis: 'detected-from-media' }, {})
  assert.equal(detected.policies.language.origin, 'media-context')
  assert.equal(detected.policies.language.rule, 'source-observation')
  assert.ok(detected.policies.language.evidenceRefs.includes('transcript-language:detected-from-media'))
  assert.deepEqual(detected.openQuestions.map((item) => item.id), [])
})

test('a declared language the detection contradicts is a question, and agreement (any region) is not', () => {
  const request = createEditorialRequest({})
  const contradicted = resolveEditorialPolicies(request, { ...media, transcriptLanguage: 'aa', transcriptLanguageBasis: 'detected-from-media', declaredLocale: 'bb-CC' }, {})
  assert.deepEqual(contradicted.openQuestions.map((item) => item.id), ['declared-language-differs-from-speech'])
  const sameLanguage = resolveEditorialPolicies(request, { ...media, transcriptLanguage: 'aa', transcriptLanguageBasis: 'detected-from-media', declaredLocale: 'aa-CC' }, {})
  assert.deepEqual(sameLanguage.openQuestions.map((item) => item.id), [])
  // no declaration: nothing to contradict
  const none = resolveEditorialPolicies(request, { ...media, transcriptLanguage: 'aa', transcriptLanguageBasis: 'detected-from-media' }, {})
  assert.deepEqual(none.openQuestions.map((item) => item.id), [])
})
