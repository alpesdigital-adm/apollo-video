import assert from 'node:assert/strict'
import test from 'node:test'

import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { answerBriefQuestions, directivesOfChoices, parseBriefInterpretation } from '../../src/v2/domain/editorial-request.ts'

/**
 * ADR-160. A question whose answers are closed (the briefing says two things the Apollo can do about one subject) carries them as choices. Choosing one is
 * the owner's answer and becomes the structured directive of the same revision; nothing is chosen for them, and a question without closed answers is
 * answered in the owner's words. The briefings are synthetic placeholders.
 */
const BRIEFING = 'alpha beta gamma delta epsilon'
const model = (answer) => ({ provider: 'test-double', model: 'stub-1', costBasis: 'api-metered', async interpret() { return { text: JSON.stringify(answer) } } })
const layout = (value, quote) => ({ kind: 'layout', value, param: null, quote })
const read = (answer, briefing = BRIEFING) => interpretBriefService({ model: model({ unsupported: [], questions: [], coverage: [], ...answer }) })({ briefing })

test('two answers the Apollo can do about one subject are asked as a question with two choices, and neither is picked', async () => {
  const { interpretation } = await read({ directives: [layout('source-native', 'alpha'), layout('fit-with-backdrop', 'beta')] })
  assert.deepEqual(interpretation.directives, [], 'both directives leave: the owner decides')
  assert.equal(interpretation.questions.length, 1)
  const [question] = interpretation.questions
  assert.equal(question.status, 'open')
  assert.deepEqual(question.choices.map((choice) => [choice.id, choice.directive.kind, choice.directive.value]), [['c1', 'layout', 'source-native'], ['c2', 'layout', 'fit-with-backdrop']])
  assert.ok(question.choices.every((choice) => choice.label.length > 0))
  assert.deepEqual(parseBriefInterpretation(JSON.parse(JSON.stringify(interpretation)), BRIEFING).interpretationHash, interpretation.interpretationHash)
})

test('a conflict between things the Apollo cannot all do yet stays a question in words, with no choices', async () => {
  // One of the two (no movement) is something the Apollo does and the other (a pan) is not: the answers are not all doable, so they are not closed.
  const movement = (value, quote) => ({ kind: 'movement', value, param: null, quote })
  const { interpretation } = await read({ directives: [movement('none', 'alpha'), movement('pan', 'beta')] })
  assert.equal(interpretation.questions.length, 1)
  assert.equal(interpretation.questions[0].choices, undefined)
})

test('a choice is the answer and the directive of the revision; a word answer to a closed question, or both, is refused', async () => {
  const { interpretation } = await read({ directives: [layout('source-native', 'alpha'), layout('fit-with-backdrop', 'beta')] })
  const chosen = [{ questionId: 'q1', choiceId: 'c2' }]
  assert.deepEqual(directivesOfChoices(interpretation, chosen).map((directive) => [directive.id, directive.kind, directive.value]), [['answer-q1', 'layout', 'fit-with-backdrop']])
  const answered = answerBriefQuestions(interpretation, BRIEFING, chosen)
  assert.equal(answered.questions[0].status, 'answered')
  assert.equal(answered.questions[0].answer, interpretation.questions[0].choices[1].label, 'the answer recorded is the words of the choice')
  const refused = (answers) => assert.throws(() => answerBriefQuestions(interpretation, BRIEFING, answers), (error) => error.code === 'INVALID_ARGUMENT')
  refused([{ questionId: 'q1', answer: 'texto livre' }])
  refused([{ questionId: 'q1', answer: 'texto', choiceId: 'c1' }])
  refused([{ questionId: 'q1', choiceId: 'c9' }])
  assert.throws(() => directivesOfChoices(interpretation, [{ questionId: 'q1', choiceId: 'c9' }]), (error) => error.code === 'INVALID_ARGUMENT')
})

test('a question the model asks has no closed answers: it is answered in words, and a choice for it is refused', async () => {
  const { interpretation } = await read({ directives: [], questions: [{ question: 'Qual das duas?', quote: 'alpha' }] })
  assert.equal(interpretation.questions[0].choices, undefined)
  const answered = answerBriefQuestions(interpretation, BRIEFING, [{ questionId: 'q1', answer: '  a primeira  ' }])
  assert.equal(answered.questions[0].answer, 'a primeira')
  assert.throws(() => answerBriefQuestions(interpretation, BRIEFING, [{ questionId: 'q1', choiceId: 'c1' }]), (error) => error.code === 'INVALID_ARGUMENT')
})

test('choices are sealed with the interpretation: one choice, a repeated id or a value outside the vocabulary is refused', async () => {
  const { interpretation } = await read({ directives: [layout('source-native', 'alpha'), layout('fit-with-backdrop', 'beta')] })
  const wire = JSON.parse(JSON.stringify(interpretation))
  const tamper = (change) => { const copy = structuredClone(wire); change(copy.questions[0]); return copy }
  for (const copy of [
    tamper((question) => { question.choices = question.choices.slice(0, 1) }),
    tamper((question) => { question.choices[1].id = 'c1' }),
    tamper((question) => { question.choices[0].directive.value = 'not-in-the-vocabulary' }),
    tamper((question) => { question.choices[0].label = 'outro texto' }),
  ]) assert.throws(() => parseBriefInterpretation(copy, BRIEFING), (error) => error.code === 'INVALID_ARGUMENT')
})
