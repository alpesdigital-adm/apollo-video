import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  BRIEF_INTERPRETATION_SCHEMA, EDITORIAL_DIRECTIVE_KINDS, EDITORIAL_DIRECTIVE_VOCABULARY, EDITORIAL_EXECUTABLE_VALUES, EDITORIAL_REQUEST_SCHEMA,
  createBriefInterpretation, createEditorialRequest, deriveEditorialRequestFromBrief, parseBriefInterpretation, parseEditorialDirective,
} from '../../src/v2/domain/editorial-request.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'

// Fixtures use synthetic briefings about nothing in particular: the content of a video belongs to its request, never to the product.
const BRIEFING = 'alpha beta gamma delta epsilon'
const interpreter = { provider: 'test-double', model: 'stub-1', promptVersion: 'p1' }
const excerptOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length, text: needle })

test('every executable value is inside the closed vocabulary, and every kind has both', () => {
  assert.deepEqual([...Object.keys(EDITORIAL_DIRECTIVE_VOCABULARY)].sort(), [...EDITORIAL_DIRECTIVE_KINDS].sort())
  assert.deepEqual([...Object.keys(EDITORIAL_EXECUTABLE_VALUES)].sort(), [...EDITORIAL_DIRECTIVE_KINDS].sort())
  for (const kind of EDITORIAL_DIRECTIVE_KINDS) {
    for (const value of EDITORIAL_EXECUTABLE_VALUES[kind]) {
      assert.ok(EDITORIAL_DIRECTIVE_VOCABULARY[kind].values.includes(value), `${kind} ${value} is executable but not in the vocabulary`)
    }
  }
  // Movement other than none is understood, not executable: the renderer executes no effect.
  assert.deepEqual(EDITORIAL_EXECUTABLE_VALUES.movement, ['none'])
})

test('a directive must be inside the vocabulary: kind, value and the parameter that value takes', () => {
  assert.equal(parseEditorialDirective({ id: 'd1', kind: 'movement', value: 'none' }, 't').value, 'none')
  assert.equal(parseEditorialDirective({ id: 'd2', kind: 'opening', value: 'protect-seconds', param: 3 }, 't').param, 3)
  assert.equal(parseEditorialDirective({ id: 'd3', kind: 'caption-language', value: 'set', param: 'en-US' }, 't').param, 'en-US')
  for (const bad of [
    { id: 'd', kind: 'tone', value: 'warm' },
    { id: 'd', kind: 'movement', value: 'dolly' },
    { id: 'd', kind: 'movement', value: 'none', param: 1 },
    { id: 'd', kind: 'opening', value: 'protect-seconds' },
    { id: 'd', kind: 'opening', value: 'protect-seconds', param: 0 },
    { id: 'd', kind: 'opening', value: 'protect-seconds', param: 31 },
    { id: 'd', kind: 'caption-language', value: 'set', param: 'not a tag' },
    { id: '', kind: 'movement', value: 'none' },
    { id: 'd', kind: 'movement', value: 'none', extra: true },
    { id: 'd', kind: 'movement', value: 'none', excerpt: { start: 0, end: 1, text: 'a' } },
  ]) assert.throws(() => parseEditorialDirective(bad, 't'), (error) => error.code === 'INVALID_ARGUMENT', JSON.stringify(bad))
})

test('any non-empty text is a valid briefing, and an absent briefing is simply absent', () => {
  for (const text of ['x', 'um', BRIEFING, 'a\nb\nc']) assert.equal(createEditorialRequest({ briefing: text }).briefing.text, text)
  const empty = createEditorialRequest({})
  assert.equal(empty.briefing, undefined)
  assert.deepEqual(empty.directives, [])
  assert.deepEqual(empty.variantOverrides, {})
  assert.equal(empty.schemaVersion, EDITORIAL_REQUEST_SCHEMA)
  assert.throws(() => createEditorialRequest({ briefing: '   ' }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => createEditorialRequest({ briefing: 'x'.repeat(10_001) }), (error) => error.code === 'INVALID_ARGUMENT')
})

test('the request hash is the hash of what the brief says, and ignores the removals', () => {
  const base = createEditorialRequest({ briefing: BRIEFING, objective: 'discovery' })
  assert.match(base.requestHash, /^[a-f0-9]{64}$/)
  assert.equal(createEditorialRequest({ briefing: BRIEFING, objective: 'discovery' }).requestHash, base.requestHash)
  assert.notEqual(createEditorialRequest({ briefing: `${BRIEFING}!`, objective: 'discovery' }).requestHash, base.requestHash)
  assert.notEqual(createEditorialRequest({ briefing: BRIEFING, objective: 'awareness' }).requestHash, base.requestHash)
  assert.notEqual(createEditorialRequest({ briefing: BRIEFING, objective: 'discovery', directives: [{ id: 'm', kind: 'movement', value: 'none' }] }).requestHash, base.requestHash)
  // Removals are Commands of the lineage; the policy resolution seals them. The brief-derived hash does not move with them.
  assert.equal(createEditorialRequest({ briefing: BRIEFING, objective: 'discovery', requestedRemovals: ['rule-b', 'rule-a'] }).requestHash, base.requestHash)
  assert.deepEqual(createEditorialRequest({ requestedRemovals: ['rule-b', 'rule-a', 'rule-a'] }).requestedRemovals, ['rule-a', 'rule-b'])
})

test('two directives that disagree about a kind are refused: that is a question, not a pick', () => {
  assert.throws(() => createEditorialRequest({ directives: [
    { id: 'a', kind: 'movement', value: 'none' }, { id: 'b', kind: 'movement', value: 'zoom-in' },
  ] }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => createEditorialRequest({ directives: [
    { id: 'a', kind: 'movement', value: 'none' }, { id: 'a', kind: 'cta', value: 'none' },
  ] }), (error) => error.code === 'INVALID_ARGUMENT')
})

test('an interpretation cites the exact words of the briefing, and a citation that is not the briefing is refused', () => {
  const interpretation = createBriefInterpretation({
    briefingText: BRIEFING, interpreter,
    directives: [{ id: 'i1', kind: 'movement', value: 'none', excerpt: excerptOf(BRIEFING, 'beta gamma') }],
    unsupported: [{ id: 'u1', excerpt: excerptOf(BRIEFING, 'delta'), summary: 'something the vocabulary lacks', reason: 'outside-vocabulary' }],
    questions: [{ id: 'q1', question: 'Which one?', excerpt: excerptOf(BRIEFING, 'epsilon'), status: 'open' }],
  })
  assert.equal(interpretation.schemaVersion, BRIEF_INTERPRETATION_SCHEMA)
  assert.equal(interpretation.briefingSha256, createHash('sha256').update(BRIEFING).digest('hex'))
  assert.equal(parseBriefInterpretation(JSON.parse(JSON.stringify(interpretation)), BRIEFING).interpretationHash, interpretation.interpretationHash)

  const wrongText = { ...interpretation.directives[0], excerpt: { ...interpretation.directives[0].excerpt, text: 'beta gammA' } }
  assert.throws(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [wrongText] }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [{ id: 'i', kind: 'movement', value: 'none', excerpt: { start: 0, end: 999, text: BRIEFING } }] }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [{ id: 'i', kind: 'tone', value: 'warm', excerpt: excerptOf(BRIEFING, 'alpha') }] }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [{ id: 'i', kind: 'movement', value: 'none' }] }), (error) => error.code === 'INVALID_ARGUMENT')
})

test('an interpretation of other text, or with a changed byte, is not accepted for this briefing', () => {
  const interpretation = createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [{ id: 'i1', kind: 'cta', value: 'none', excerpt: excerptOf(BRIEFING, 'alpha') }] })
  assert.throws(() => parseBriefInterpretation(JSON.parse(JSON.stringify(interpretation)), `${BRIEFING} more`), (error) => error.code === 'INVALID_ARGUMENT')
  const tampered = JSON.parse(JSON.stringify(interpretation))
  tampered.directives[0].value = 'verbal-only'
  assert.throws(() => parseBriefInterpretation(tampered, BRIEFING), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => createEditorialRequest({ interpretation }), (error) => error.code === 'INVALID_ARGUMENT')
  const request = createEditorialRequest({ briefing: BRIEFING, interpretation })
  assert.equal(request.interpretation.interpretationHash, interpretation.interpretationHash)
  assert.notEqual(request.requestHash, createEditorialRequest({ briefing: BRIEFING }).requestHash)
})

test('the request is read back from a Brief Snapshot by one function, stable under the fields the Director rewrites', () => {
  const objective = 'discovery'
  const desiredAction = createDesiredAction({ objective })
  const brief = { schemaVersion: 2, objective, desiredAction, productionBrief: { schemaVersion: 1, ownerInput: { text: BRIEFING, trust: 'owner-authorized' } } }
  const request = deriveEditorialRequestFromBrief(brief)
  assert.equal(request.briefing.text, BRIEFING)
  assert.equal(request.objective, objective)
  assert.equal(request.desiredAction.kind, 'continue-viewing')
  // The Director rewrites schemaVersion and adds briefCompilation / objectiveChange: none of it is part of the request.
  const rewritten = { ...brief, schemaVersion: 3, briefCompilation: { anything: true }, objectiveChange: { reason: 'x' } }
  assert.equal(deriveEditorialRequestFromBrief(rewritten).requestHash, request.requestHash)
  // A brief with no free text has no briefing: absence stays absence.
  const mediaOnly = deriveEditorialRequestFromBrief({ schemaVersion: 2, objective, desiredAction, productionBrief: { schemaVersion: 1, summary: { text: 'x' } } })
  assert.equal(mediaOnly.briefing, undefined)
  assert.notEqual(mediaOnly.requestHash, request.requestHash)
  // The structured part survives the round trip through the snapshot.
  const structured = { ...brief, editorialRequest: { directives: [{ id: 'm', kind: 'movement', value: 'none' }] } }
  assert.equal(deriveEditorialRequestFromBrief(structured).directives.length, 1)
  assert.throws(() => deriveEditorialRequestFromBrief({ ...brief, editorialRequest: { tone: 'x' } }), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('coverage is part of the interpretation only when the interpreter found a topic, and cites the briefing like everything else', async () => {
  const { assertBriefingInterpreted, BRIEF_COVERAGE_TOPICS } = await import('../../src/v2/domain/editorial-request.ts')
  assert.deepEqual([...BRIEF_COVERAGE_TOPICS], ['audience', 'offer', 'tone'])
  const plain = createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [] })
  const same = createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [], coverage: [] })
  // No coverage found hashes exactly as before coverage existed.
  assert.equal(same.interpretationHash, plain.interpretationHash)
  assert.equal(plain.coverage, undefined)
  const covered = createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [], coverage: [{ topic: 'tone', excerpt: excerptOf(BRIEFING, 'beta') }] })
  assert.notEqual(covered.interpretationHash, plain.interpretationHash)
  assert.deepEqual(parseBriefInterpretation(JSON.parse(JSON.stringify(covered)), BRIEFING), covered)
  assert.throws(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [], coverage: [{ topic: 'tone', excerpt: { start: 0, end: 4, text: 'beta' } }] }),
    (error) => error.code === 'INVALID_ARGUMENT')
  // Two statements of one topic are two items; the very same words under the same topic twice are refused.
  assert.doesNotThrow(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [],
    coverage: [{ topic: 'tone', excerpt: excerptOf(BRIEFING, 'beta') }, { topic: 'tone', excerpt: excerptOf(BRIEFING, 'gamma') }] }))
  assert.throws(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [],
    coverage: [{ topic: 'tone', excerpt: excerptOf(BRIEFING, 'beta') }, { topic: 'tone', excerpt: excerptOf(BRIEFING, 'beta') }] }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => createBriefInterpretation({ briefingText: BRIEFING, interpreter, directives: [], coverage: [{ topic: 'budget', excerpt: excerptOf(BRIEFING, 'beta') }] }),
    (error) => error.code === 'INVALID_ARGUMENT')
  // Coverage found changes the request: the Director plans from the request it sealed.
  assert.notEqual(createEditorialRequest({ briefing: BRIEFING, interpretation: covered }).requestHash, createEditorialRequest({ briefing: BRIEFING, interpretation: plain }).requestHash)
  // A briefing with text and no interpretation of it is a request nobody read: the Director refuses it, it is not an empty briefing.
  assert.throws(() => assertBriefingInterpreted(createEditorialRequest({ briefing: BRIEFING })),
    (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpretation-required')
  assert.doesNotThrow(() => assertBriefingInterpreted(createEditorialRequest({ briefing: BRIEFING, interpretation: plain })))
  assert.doesNotThrow(() => assertBriefingInterpreted(createEditorialRequest({})))
  // The audit rides in the brief but is not the request.
  const brief = { objective: 'discovery', productionBrief: { ownerInput: { text: BRIEFING } }, editorialRequest: { interpretation: plain, interpretationAudit: { schemaVersion: 'brief-interpretation-audit/v1' } } }
  assert.equal(deriveEditorialRequestFromBrief(brief).requestHash, createEditorialRequest({ briefing: BRIEFING, objective: 'discovery', interpretation: plain }).requestHash)
})
