import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRIEF_INTERPRETER_PROMPT_VERSION, BRIEF_INTERPRETER_SYSTEM_PROMPT, interpretBriefService, interpretationFromModelText,
} from '../../src/v2/application/interpret-brief.ts'
import {
  EDITORIAL_DIRECTIVE_KINDS, EDITORIAL_DIRECTIVE_VOCABULARY, EDITORIAL_EXECUTABLE_VALUES, briefingSentences, createEditorialRequest, parseBriefInterpretation,
  parseEditorialDirective, unaccountedSentences,
} from '../../src/v2/domain/editorial-request.ts'
import { describeDirectiveLine, notExecutableSummary } from '../../src/v2/domain/editorial-request-texts.ts'
import { createBriefInterpreterModelFromEnvironment } from '../../src/v2/infrastructure/brief/brief-interpreter-factory.ts'
import { startBriefInterpreterStandIn } from './helpers/brief-interpreter-stand-in.mjs'
import { W70_BRIEFING, W70_CLAUSES, W70_COVERAGE_MODEL_ANSWER, W70_RUN1_MODEL_ANSWER } from './helpers/w70-briefing-fixture.mjs'

const model = (answer) => ({ provider: 'test-double', model: 'stub-1', costBasis: 'subscription', async interpret() { return { text: JSON.stringify(answer) } } })
const empty = { directives: [], unsupported: [], questions: [], coverage: [] }
const interpret = (answer, briefing) => interpretBriefService({ model: model(answer) })({ briefing })
const items = (interpretation) => [...interpretation.directives, ...interpretation.unsupported, ...interpretation.questions, ...(interpretation.coverage ?? [])]

/**
 * THE COVERAGE RULE (ADR-160): every sentence of a briefing, and every clause of a sentence that asks for different things, ends in an item of the
 * reading - a directive (executable, satisfied, or understood and not executable), an unsupported item, a question or a statement. This is the check
 * that fails when part of a briefing is lost; it is used on a stand-in provider and on the answers of a model.
 */
function assertEveryPartAccounted(briefing, interpretation, parts = briefingSentences(briefing, { clauses: true })) {
  const lost = unaccountedSentences(briefing, items(interpretation), { clauses: true }).map((part) => part.text)
  assert.deepEqual(lost, [], `part of the briefing ended in no item: ${JSON.stringify(lost)}`)
  for (const part of parts) {
    assert.ok(items(interpretation).some((item) => item.excerpt && item.excerpt.start < part.end && item.excerpt.end > part.start), `no item stands on: ${part.text}`)
  }
}

test('ADR-160 coverage: the vocabulary teaches the reading what the Apollo already does, and the prompt is a new version with its own hash', () => {
  assert.equal(BRIEF_INTERPRETER_PROMPT_VERSION, 'brief-interpreter/v2')
  for (const kind of ['cta-text', 'output', 'output-layout', 'remove-speech', 'invariant', 'absent']) {
    assert.ok(EDITORIAL_DIRECTIVE_KINDS.includes(kind), kind)
    assert.ok(BRIEF_INTERPRETER_SYSTEM_PROMPT.includes(`- ${kind}:`), `the prompt names ${kind}`)
  }
  // The first nine kinds keep their order: the ids of a reading follow it.
  assert.deepEqual(EDITORIAL_DIRECTIVE_KINDS.slice(0, 9), ['movement', 'opening', 'structure', 'cta', 'layout', 'caption-language', 'caption-style', 'keep', 'avoid'])
  // What the Apollo cannot execute is marked for the model, so it reports it instead of asking about it; what it executes is not.
  assert.match(BRIEF_INTERPRETER_SYSTEM_PROMPT, /zoom[^|\n]*\[understood, not executable yet\]/)
  assert.doesNotMatch(BRIEF_INTERPRETER_SYSTEM_PROMPT, /fill-following-face[^|\n]*\[understood, not executable yet\]/)
  assert.match(BRIEF_INTERPRETER_SYSTEM_PROMPT, /Never ask about the details of a request that is outside the vocabulary/)
  assert.match(BRIEF_INTERPRETER_SYSTEM_PROMPT, /Account for every sentence of the briefing/)
  // The executable table is a subset of the vocabulary, kind by kind.
  for (const kind of EDITORIAL_DIRECTIVE_KINDS) {
    for (const value of EDITORIAL_EXECUTABLE_VALUES[kind]) assert.ok(EDITORIAL_DIRECTIVE_VOCABULARY[kind].values.includes(value), `${kind} ${value}`)
  }
  // The renderer applies no movement and the Apollo cuts no spoken subject by itself: neither is claimed as executable ahead of the work that does it.
  assert.deepEqual(EDITORIAL_EXECUTABLE_VALUES.movement, ['none'])
  assert.equal(EDITORIAL_EXECUTABLE_VALUES.keep.length + EDITORIAL_EXECUTABLE_VALUES.avoid.length, 0)
})

test('ADR-160 coverage: the new kinds take only the parameters they mean', () => {
  const ok = (directive) => parseEditorialDirective({ id: 'd1', ...directive }, 'test')
  assert.equal(ok({ kind: 'output', value: 'vertical' }).value, 'vertical')
  assert.equal(ok({ kind: 'output', value: 'aspect', param: '9:16' }).param, '9:16')
  assert.equal(ok({ kind: 'output-layout', value: 'fill-following-face', param: 'vertical' }).param, 'vertical')
  assert.equal(ok({ kind: 'output-layout', value: 'source-native', param: '16:9' }).param, '16:9')
  assert.equal(ok({ kind: 'output-layout', value: 'fit-with-backdrop', param: 'all' }).param, 'all')
  assert.equal(ok({ kind: 'cta-text', value: 'set', param: '<texto>' }).param, '<texto>')
  assert.equal(ok({ kind: 'remove-speech', value: 'about', param: '<assunto>' }).param, '<assunto>')
  assert.equal(ok({ kind: 'invariant', value: 'captions-clear-of-face' }).kind, 'invariant')
  assert.equal(ok({ kind: 'absent', value: 'music' }).kind, 'absent')
  assert.equal(ok({ kind: 'movement', value: 'zoom' }).value, 'zoom')
  for (const wrong of [
    { kind: 'output', value: 'aspect' }, { kind: 'output', value: 'aspect', param: '7:5' }, { kind: 'output', value: 'vertical', param: '9:16' },
    { kind: 'output-layout', value: 'fill-following-face' }, { kind: 'output-layout', value: 'fill-following-face', param: 'tall' },
    { kind: 'cta-text', value: 'set' }, { kind: 'remove-speech', value: 'about', param: '' }, { kind: 'invariant', value: 'captions-clear-of-face', param: 'x' },
    { kind: 'absent', value: 'lights' }, { kind: 'invariant', value: 'music' },
  ]) {
    assert.throws(() => ok(wrong), (error) => error.code === 'INVALID_ARGUMENT', JSON.stringify(wrong))
  }
  // Several versions may be asked for, and the frame of each; the same output asked two different things is the one thing that disagrees.
  assert.doesNotThrow(() => createEditorialRequest({ directives: [
    { id: 'a', kind: 'output', value: 'vertical' }, { id: 'b', kind: 'output', value: 'horizontal' },
    { id: 'c', kind: 'output-layout', value: 'fill-following-face', param: 'vertical' }, { id: 'd', kind: 'output-layout', value: 'source-native', param: 'horizontal' },
    { id: 'e', kind: 'remove-speech', value: 'about', param: 'um' }, { id: 'f', kind: 'remove-speech', value: 'about', param: 'dois' },
  ] }))
  assert.throws(() => createEditorialRequest({ directives: [
    { id: 'c', kind: 'output-layout', value: 'fill-following-face', param: 'vertical' }, { id: 'd', kind: 'output-layout', value: 'source-native', param: 'vertical' },
  ] }), (error) => error.code === 'INVALID_ARGUMENT' && /disagree/.test(error.message))
  assert.throws(() => createEditorialRequest({ directives: [
    { id: 'a', kind: 'cta-text', value: 'set', param: 'um' }, { id: 'b', kind: 'cta-text', value: 'set', param: 'outro' },
  ] }), (error) => error.code === 'INVALID_ARGUMENT')
})

test('ADR-160 coverage W70: the answer the real model gave under the first prompt is still read, and what it left in a question stays a question for a choice the Apollo can now make', async () => {
  const { interpretation } = await interpret(W70_RUN1_MODEL_ANSWER, W70_BRIEFING)
  // It is a valid reading of the briefing, and every sentence of it ends in an item (the first prompt already accounted for them; it just could not map them).
  assert.doesNotThrow(() => parseBriefInterpretation(JSON.parse(JSON.stringify(interpretation)), W70_BRIEFING))
  assert.deepEqual(interpretation.unaccounted, undefined)
  assert.deepEqual(interpretation.directives.map((item) => [item.kind, item.value]), [['cta', 'overlay-at-spoken-cta'], ['avoid', 'subject'], ['avoid', 'subject']])
  assert.equal(interpretation.unsupported.length, 4)
  // The frame is a choice between two things the Apollo does (the fill is no longer "not done"), so the question carries closed answers.
  const frame = interpretation.questions.find((question) => /enquadramento/.test(question.question))
  assert.deepEqual(frame.choices.map((choice) => [choice.directive.kind, choice.directive.value]), [['layout', 'fill-crop'], ['layout', 'source-native']])
  assert.doesNotMatch(frame.question, /ainda não faz/)
})

test('ADR-160 coverage W70: a model that follows the new prompt maps every part of the briefing; nothing is unaccounted, nothing is asked about what will not be done', async () => {
  const { interpretation, audit } = await interpret(W70_COVERAGE_MODEL_ANSWER, W70_BRIEFING)
  assertEveryPartAccounted(W70_BRIEFING, interpretation)
  // ...including the clauses the test fixture lists by hand, each with the item that stands on it.
  for (const clause of W70_CLAUSES) {
    const start = W70_BRIEFING.indexOf(clause)
    assert.ok(start >= 0, clause)
    assert.ok(items(interpretation).some((item) => item.excerpt.start < start + clause.length && item.excerpt.end > start), `no item stands on: ${clause}`)
  }
  assert.equal(interpretation.unaccounted, undefined)
  assert.deepEqual(audit.signals, [])
  assert.deepEqual(interpretation.questions, [], 'a request the Apollo will not do is not asked about')
  // What the briefing asks, kind by kind.
  const byKind = (kind) => interpretation.directives.filter((item) => item.kind === kind).map((item) => `${item.value}${item.param === undefined ? '' : `:${item.param}`}`)
  assert.deepEqual(byKind('output'), ['vertical', 'horizontal'])
  assert.deepEqual(byKind('output-layout'), ['fill-following-face:vertical', 'source-native:horizontal'])
  assert.deepEqual(byKind('cta-text'), ['set:Trave sua agenda'])
  assert.deepEqual(byKind('cta'), ['overlay-at-spoken-cta'])
  assert.deepEqual(byKind('remove-speech'), ['about:sorteio', 'about:formulário de inscrição'])
  assert.deepEqual(byKind('invariant'), ['captions-clear-of-face'])
  assert.deepEqual(byKind('absent'), ['music'])
  // The zoom is told as what it is, and the only thing left outside the vocabulary is the length of the captions.
  assert.deepEqual(byKind('movement'), ['zoom'])
  assert.deepEqual(interpretation.unsupported.map((item) => [item.reason, item.excerpt.text]), [['outside-vocabulary', 'Legendas curtas']])
  assert.deepEqual(interpretation.coverage.map((item) => item.topic), ['audience', 'tone', 'context'])
  assert.equal(describeDirectiveLine('movement', 'zoom'), 'Movimento de câmera: Zoom (o Apollo ainda não aplica zoom)')
})

test('ADR-160 coverage: a sentence nobody stands on is listed in the reading and signalled in the audit, and the check of coverage fails on it', async () => {
  const answer = { ...W70_COVERAGE_MODEL_ANSWER, directives: W70_COVERAGE_MODEL_ANSWER.directives.filter((item) => item.kind !== 'movement') }
  const { interpretation, audit } = await interpret(answer, W70_BRIEFING)
  assert.deepEqual(interpretation.unaccounted.map((item) => item.excerpt.text), ['Pode dar um leve zoom no começo para dar energia.'])
  assert.deepEqual(audit.signals, ['sentence-unaccounted'])
  assert.throws(() => assertEveryPartAccounted(W70_BRIEFING, interpretation), /ended in no item|no item stands on/)
  // The reading is still sealed and valid: it states what it did not read, it does not pretend.
  assert.doesNotThrow(() => parseBriefInterpretation(JSON.parse(JSON.stringify(interpretation)), W70_BRIEFING))
  // A model that returns nothing for a briefing with words leaves every sentence unaccounted - the case the coverage check exists for.
  const nothing = await interpret(empty, W70_BRIEFING)
  assert.equal(nothing.interpretation.unaccounted.length, briefingSentences(W70_BRIEFING).length)
  assert.throws(() => assertEveryPartAccounted(W70_BRIEFING, nothing.interpretation))
})

test('ADR-160 coverage: sentences are read from punctuation alone, in any language, and clauses also end at a semicolon', () => {
  const text = 'One. Two words! Is it three? Four\nfive; six.'
  assert.deepEqual(briefingSentences(text).map((part) => part.text), ['One.', 'Two words!', 'Is it three?', 'Four', 'five; six.'])
  assert.deepEqual(briefingSentences(text, { clauses: true }).map((part) => part.text), ['One.', 'Two words!', 'Is it three?', 'Four', 'five;', 'six.'])
  for (const part of briefingSentences(text, { clauses: true })) assert.equal(text.slice(part.start, part.end), part.text)
  assert.deepEqual(briefingSentences('  \n ... \n'), [])
})

test('ADR-160 coverage: every zoom is one zoom the Apollo does not apply - no question about which way it goes; asks of one kind that the Apollo does not do are one item', async () => {
  const briefing = 'um leve zoom no começo, depois um zoom de saída, e uma panorâmica lenta'
  const zooms = await interpret({ ...empty, directives: [
    { kind: 'movement', value: 'zoom-in', param: null, quote: 'um leve zoom no começo' }, { kind: 'movement', value: 'zoom-out', param: null, quote: 'um zoom de saída' },
  ] }, briefing)
  assert.deepEqual(zooms.interpretation.directives.map((item) => [item.kind, item.value]), [['movement', 'zoom']])
  assert.deepEqual(zooms.interpretation.questions, [])
  assert.equal(zooms.audit.directivesWithdrawnAsAmbiguous, 0)
  const mixed = await interpret({ ...empty, directives: [
    { kind: 'movement', value: 'zoom-in', param: null, quote: 'um leve zoom no começo' }, { kind: 'movement', value: 'pan', param: null, quote: 'uma panorâmica lenta' },
  ] }, briefing)
  assert.deepEqual(mixed.interpretation.directives, [])
  assert.deepEqual(mixed.interpretation.questions, [])
  assert.deepEqual(mixed.interpretation.unsupported.map((item) => item.reason), ['not-executable'])
  assert.match(mixed.interpretation.unsupported[0].summary, /^Movimento de câmera: .*zoom.* ou .*não aplica/)
  // The Apollo does one of the two (no movement) and not the other: that IS a choice, so it is asked, with closed answers.
  const choice = await interpret({ ...empty, directives: [
    { kind: 'movement', value: 'none', param: null, quote: 'um leve zoom no começo' }, { kind: 'movement', value: 'pan', param: null, quote: 'uma panorâmica lenta' },
  ] }, briefing)
  assert.equal(choice.interpretation.questions.length, 1)
  assert.equal(choice.interpretation.questions[0].choices, undefined, 'one of the two answers is not something the Apollo does, so the answers are not closed')
  assert.equal(choice.audit.directivesWithdrawnAsAmbiguous, 2)
})

test('ADR-160 coverage: a question the model asks about the words of a request that will not be done is dropped; the words stay accounted by the item that says so', async () => {
  const briefing = 'dê um leve zoom no começo. Fale devagar.'
  const { interpretation, audit } = await interpret({ ...empty, directives: [{ kind: 'movement', value: 'zoom', param: null, quote: 'um leve zoom no começo' }],
    questions: [{ question: 'O zoom aproxima ou afasta?', quote: 'leve zoom' }, { question: 'Quão devagar?', quote: 'Fale devagar' }] }, briefing)
  assert.deepEqual(interpretation.questions.map((item) => item.question), ['Quão devagar?'])
  assert.deepEqual(audit.signals, ['moot-question-dropped'])
  assert.equal(interpretation.unaccounted, undefined)
  // A question with no quote is kept: nothing says it is about the zoom.
  const loose = await interpret({ ...empty, directives: [{ kind: 'movement', value: 'zoom', param: null, quote: 'um leve zoom no começo' }], questions: [{ question: 'Qual é o público?', quote: null }] }, briefing)
  assert.equal(loose.interpretation.questions.length, 1)
})

test('ADR-160 coverage: the layout of two different outputs is two directives; the layout of one output said two ways is a question that keeps the output', async () => {
  const briefing = 'vertical preenche; horizontal mantém; e a vertical encaixa com fundo'
  const { interpretation } = await interpret({ ...empty, directives: [
    { kind: 'output-layout', value: 'fill-following-face', param: 'Vertical', quote: 'vertical preenche' },
    { kind: 'output-layout', value: 'source-native', param: 'horizontal', quote: 'horizontal mantém' },
    { kind: 'output-layout', value: 'fit-with-backdrop', param: 'vertical', quote: 'a vertical encaixa com fundo' },
  ] }, briefing)
  assert.deepEqual(interpretation.directives.map((item) => [item.value, item.param]), [['source-native', 'horizontal']])
  assert.equal(interpretation.questions.length, 1)
  assert.match(interpretation.questions[0].question, /Enquadramento de uma versão/i)
  assert.deepEqual(interpretation.questions[0].choices.map((choice) => [choice.directive.kind, choice.directive.value, choice.directive.param]),
    [['output-layout', 'fill-following-face', 'vertical'], ['output-layout', 'fit-with-backdrop', 'vertical']])
  for (const choice of interpretation.questions[0].choices) assert.doesNotMatch(choice.label, /output-layout|fill-following-face|vertical,/)
})

test('ADR-160 coverage: the words of the call, the subject to take out and the subject to keep must be the briefing\'s; a made-up subject is not a directive', async () => {
  const briefing = 'mostre "Fale conosco" e tire o que fala de preços'
  const { interpretation, audit } = await interpret({ ...empty, directives: [
    { kind: 'cta-text', value: 'set', param: 'Fale conosco', quote: 'mostre "Fale conosco"' },
    { kind: 'remove-speech', value: 'about', param: 'preços', quote: 'tire o que fala de preços' },
    { kind: 'remove-speech', value: 'about', param: 'garantia', quote: 'tire o que fala' },
    { kind: 'cta-text', value: 'set', param: 'Compre agora', quote: 'mostre' },
  ] }, briefing)
  assert.deepEqual(interpretation.directives.map((item) => [item.kind, item.param]), [['cta-text', 'Fale conosco'], ['remove-speech', 'preços']])
  assert.equal(interpretation.unsupported.length, 2)
  assert.equal(audit.directivesMovedToUnsupported, 2)
  // Case and accents of a reference word are not a meaning; the output a layout is for is one of the catalog.
  const refs = await interpret({ ...empty, directives: [
    { kind: 'output-layout', value: 'fill-following-face', param: ' 9:16 ', quote: 'mostre' }, { kind: 'output-layout', value: 'source-native', param: 'Wide', quote: 'tire' },
  ] }, briefing)
  assert.deepEqual(refs.interpretation.directives.map((item) => item.param), ['9:16'])
  assert.equal(refs.interpretation.unsupported.length, 1)
})

test('ADR-160 coverage: the owner reads every new code in words, and what is not done says so', () => {
  const lines = [
    describeDirectiveLine('output', 'vertical'), describeDirectiveLine('output', 'aspect', '9:16'),
    describeDirectiveLine('output-layout', 'fill-following-face', 'vertical'), describeDirectiveLine('output-layout', 'source-native', 'horizontal'),
    describeDirectiveLine('output-layout', 'fit-with-backdrop', 'all'), describeDirectiveLine('output-layout', 'fill-following-face', '9:16'),
    describeDirectiveLine('cta-text', 'set', 'Texto'), describeDirectiveLine('remove-speech', 'about', 'assunto'),
    describeDirectiveLine('invariant', 'captions-clear-of-face'), describeDirectiveLine('absent', 'music'), describeDirectiveLine('absent', 'effects'),
    describeDirectiveLine('absent', 'transitions'), describeDirectiveLine('layout', 'fill-crop'),
  ]
  for (const line of lines) {
    assert.doesNotMatch(line, /\b(?:output|layout|fill-following-face|source-native|fit-with-backdrop|cta-text|remove-speech|invariant|absent|fill-crop|captions-clear-of-face)\b/u, line)
    assert.match(line, /[a-zà-ú]/u)
  }
  assert.equal(describeDirectiveLine('output-layout', 'fill-following-face', 'vertical'), 'Enquadramento de uma versão: Preencher a tela acompanhando o rosto, na versão vertical')
  assert.equal(describeDirectiveLine('output-layout', 'source-native', 'all'), 'Enquadramento de uma versão: Manter o enquadramento da gravação, em todas as versões')
  assert.equal(describeDirectiveLine('layout', 'fill-crop'), 'Enquadramento: Preencher a tela acompanhando o rosto')
  assert.equal(notExecutableSummary('movement', 'zoom'), 'Movimento de câmera: Zoom (o Apollo ainda não aplica zoom)')
})

test('ADR-160 coverage: a stand-in of the provider answers the briefing through the real adapter, and the reading it yields accounts for the whole briefing', async () => {
  const standIn = await startBriefInterpreterStandIn()
  try {
    standIn.script.set(W70_BRIEFING, W70_COVERAGE_MODEL_ANSWER)
    const adapter = createBriefInterpreterModelFromEnvironment(standIn.environment)
    const { interpretation, audit } = await interpretBriefService({ model: adapter })({ briefing: W70_BRIEFING })
    assertEveryPartAccounted(W70_BRIEFING, interpretation)
    assert.equal(standIn.calls.length, 1)
    // The model is shown the closed vocabulary of this prompt version and a schema that names every kind.
    const sent = JSON.stringify(standIn.calls[0].body)
    for (const kind of ['output-layout', 'remove-speech', 'cta-text']) assert.ok(sent.includes(kind), kind)
    assert.equal(audit.promptVersion, BRIEF_INTERPRETER_PROMPT_VERSION)
    // An answer that maps nothing (the stand-in's fallback) is a valid reading that LISTS every sentence it left: the briefing is never silently lost.
    const other = 'Texto qualquer. Outro texto.'
    const idle = await interpretBriefService({ model: adapter })({ briefing: other })
    assert.deepEqual(idle.interpretation.unaccounted.map((item) => item.excerpt.text), ['Texto qualquer.', 'Outro texto.'])
  } finally {
    await standIn.close()
  }
})

test('ADR-160 coverage: the text a model answers is read by one function, and the first-prompt answer of W70 reads the same through it', () => {
  const read = (answer) => interpretationFromModelText({ briefingText: W70_BRIEFING, responseText: JSON.stringify(answer), interpreter: { provider: 'p', model: 'm', promptVersion: BRIEF_INTERPRETER_PROMPT_VERSION } })
  const first = read(W70_RUN1_MODEL_ANSWER)
  assert.equal(first.directivesWithdrawnAsAmbiguous, 2, 'the audit of the real run counted the same two directives withdrawn')
  assert.equal(first.directivesMovedToUnsupported, 0)
  assert.equal(first.droppedMootQuestions, 0)
  assert.equal(read(W70_COVERAGE_MODEL_ANSWER).interpretation.interpretationHash, read(W70_COVERAGE_MODEL_ANSWER).interpretation.interpretationHash)
})

test('ADR-160 coverage: the screens say what a statement does (nothing), list the sentences no item stands on, and tell why the Director stopped in the Apollo\'s words', async () => {
  const { COVERAGE_LABELS, COVERAGE_NOTE, UNACCOUNTED_NOTE, describeRequestFailure } = await import('../../src/v2/ui/editorial-request-view.ts')
  assert.equal(COVERAGE_LABELS.context, 'Contexto')
  assert.deepEqual(Object.keys(COVERAGE_LABELS), ['audience', 'offer', 'tone', 'context'])
  assert.match(COVERAGE_NOTE, /não mudam nada/)
  assert.match(UNACCOUNTED_NOTE, /não classificou/)
  assert.match(UNACCOUNTED_NOTE, /nenhuma decisão foi tomada/)
  const blocked = describeRequestFailure(428, { error: { code: 'PRECONDITION_REQUIRED', details: { reason: 'editorial-request-blocked', blockers: [
    { kind: 'unsupported', id: 'd1', text: 'Movimento de câmera: Zoom (o Apollo ainda não aplica zoom)' },
    { kind: 'question', id: 'speech-removal-1', text: 'Achei trechos sobre “assunto” na fala.' },
  ] } } })
  assert.match(blocked.message, /O pedido ainda tem uma pergunta sem resposta/)
  assert.match(blocked.message, /Zoom \(o Apollo ainda não aplica zoom\)/)
  assert.match(blocked.message, /Achei trechos sobre “assunto” na fala\./)
  // Without blockers (a batch, an older server) the message is the one it always was.
  assert.doesNotMatch(describeRequestFailure(428, { error: { code: 'PRECONDITION_REQUIRED', details: { reason: 'editorial-request-blocked' } } }).message, /Zoom/)
  const reframe = describeRequestFailure(428, { error: { code: 'PRECONDITION_REQUIRED', details: { reason: 'reframe-plan-required', variantId: 'variant-1' } } })
  assert.match(reframe.message, /preenche a tela desta saída acompanhando o rosto/)
  assert.doesNotMatch(reframe.message, /reframe|variant/i)
})
