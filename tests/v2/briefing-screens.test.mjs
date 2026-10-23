import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  BRIEFING_GUIDANCE_INTRO,
  BRIEFING_GUIDANCE_TITLE,
  BRIEFING_GUIDANCE_TOPICS,
  BRIEFING_FIELD_LABEL,
  BRIEFING_REQUIRED_MESSAGE,
  normalizeBriefingInput,
} from '../../src/v2/ui/briefing-guidance.ts'
import {
  buildAnswersBody,
  describeDirective,
  describeRequestBlock,
  describeRequestFailure,
} from '../../src/v2/ui/editorial-request-view.ts'

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/**
 * ADR-160 F7/F8. The briefing screens. The owner's literal decision: the product "pede um briefing, pode dar indicações do que é esperado
 * no briefing para um video melhor, mas aceita também briefing simples", and an example sentence never becomes a default or a recommendation.
 */
test('the guidance names the topics and nothing else: no example, no sentence to copy, no value', () => {
  assert.deepEqual(BRIEFING_GUIDANCE_TOPICS.map((topic) => topic.id), ['audience', 'goal', 'keep-or-remove', 'language', 'format', 'pace'])
  const texts = [BRIEFING_GUIDANCE_TITLE, BRIEFING_GUIDANCE_INTRO, BRIEFING_FIELD_LABEL, BRIEFING_REQUIRED_MESSAGE,
    ...BRIEFING_GUIDANCE_TOPICS.flatMap((topic) => [topic.label, topic.about])]
  for (const text of texts) {
    assert.doesNotMatch(text, /["“”'‘’]/u, `quoted text reads as a sentence to copy: ${text}`)
    assert.doesNotMatch(text, /\bex\.|exemplo|por exemplo|\bcomo em\b|\bcomo:/iu, `an example sneaked into the guidance: ${text}`)
    assert.doesNotMatch(text, /\d/u, `a number reads as a recommended value: ${text}`)
  }
  for (const topic of BRIEFING_GUIDANCE_TOPICS) assert.ok(topic.about.split(/\s+/u).length <= 12, `${topic.id} is a topic, not a paragraph`)
  assert.match(BRIEFING_GUIDANCE_INTRO, /Qualquer texto vale/)
})

test('a briefing is any non-empty text: one line is enough, and only blank is refused', () => {
  assert.equal(normalizeBriefingInput('x'), 'x')
  assert.equal(normalizeBriefingInput('  uma linha  \n'), 'uma linha')
  assert.equal(normalizeBriefingInput(''), null)
  assert.equal(normalizeBriefingInput(' \n\t '), null)
})

test('the briefing field of both screens has no placeholder, no preset value and the guidance beside it', () => {
  for (const [file, id] of [['src/app/ProjectsPageClient.tsx', 'project-briefing']]) {
    const text = source(file)
    const element = text.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>`))?.[0]
    assert.ok(element, `${file} has the briefing field`)
    assert.doesNotMatch(element, /placeholder=/, `${file}: the briefing field has no placeholder`)
    assert.match(element, /aria-required="true"/)
    assert.match(element, new RegExp(`aria-describedby=\\{?\`?"?${id}-guidance`))
    assert.match(text, new RegExp(`<BriefingGuidance id="${id}-guidance"`))
    assert.match(text, /useState\(''\)/)
  }
})

test('project creation pre-selects nothing: no objective, no language, no format', () => {
  const text = source('src/app/ProjectsPageClient.tsx')
  assert.match(text, /useState<StrategicObjectiveId \| null>\(null\)/)
  assert.match(text, /const \[locale, setLocale\] = useState\(''\)/)
  assert.doesNotMatch(text, /setFormat|useState<OutputAspectRatio>/)
  assert.doesNotMatch(text, /placeholder="Ex\./)
  // The language is optional and says what happens when it is left out.
  assert.match(text, /Se você não informar, o Apollo detecta o idioma pela fala do vídeo/)
  assert.match(text, /\.\.\.\(locale \? \{ locale \} : \{\}\)/)
})

test('the request screen says what blocks the Director, in the order the owner fixes it', () => {
  const base = { state: 'interpreted', request: { directives: [], requestHash: 'h' }, interpretation: { directives: [], questions: [] }, unsupported: [], openQuestions: [], blocksDirector: false }
  assert.equal(describeRequestBlock({ ...base, state: 'awaiting-interpretation', blocksDirector: true }).kind, 'unread')
  const asked = describeRequestBlock({ ...base, openQuestions: [{ id: 'q1', question: 'a?', excerpt: null }], blocksDirector: true })
  assert.equal(asked.kind, 'questions')
  assert.match(asked.message, /bloqueado até você responder a pergunta/)
  const two = describeRequestBlock({ ...base, openQuestions: [{ id: 'q1', question: 'a?', excerpt: null }, { id: 'q2', question: 'b?', excerpt: null }], blocksDirector: true })
  assert.match(two.message, /as 2 perguntas/)
  const unsupported = describeRequestBlock({ ...base, unsupported: [{ id: 'u1', source: 'interpretation', reason: 'not-executable', summary: 's', excerpt: 'e' }], blocksDirector: true })
  assert.equal(unsupported.kind, 'unsupported')
  assert.equal(describeRequestBlock({ ...base, state: 'no-briefing' }).kind, 'no-briefing')
  assert.equal(describeRequestBlock(base).kind, 'free')
  // An unread briefing comes first even when stale questions exist.
  assert.equal(describeRequestBlock({ ...base, state: 'awaiting-interpretation', openQuestions: [{ id: 'q1', question: 'a?', excerpt: null }], blocksDirector: true }).kind, 'unread')
})

test('answers are sent only for open questions the owner actually answered', () => {
  assert.equal(buildAnswersBody({}, ['q1']), null)
  assert.equal(buildAnswersBody({ q1: '   ' }, ['q1']), null)
  assert.deepEqual(buildAnswersBody({ q1: '  uma   resposta ', q9: 'não é pergunta aberta' }, ['q1', 'q2']), { answers: [{ questionId: 'q1', answer: 'uma resposta' }] })
})

test('a directive is shown in plain words with its parameter, never with a value the request did not carry', () => {
  assert.deepEqual(describeDirective({ kind: 'opening', value: 'protect-seconds', param: 3 }), { label: 'Abertura', text: 'proteger os primeiros segundos (3 s)' })
  assert.deepEqual(describeDirective({ kind: 'movement', value: 'none' }), { label: 'Movimento de câmera', text: 'sem movimento' })
  assert.deepEqual(describeDirective({ kind: 'caption-language', value: 'set', param: 'xx-YY' }), { label: 'Idioma das legendas', text: 'xx-YY' })
  assert.deepEqual(describeDirective({ kind: 'avoid', value: 'subject', param: 'tema do pedido' }), { label: 'Evitar', text: 'tema do pedido' })
  assert.equal(describeDirective({ kind: 'unknown-kind', value: 'v' }).label, 'unknown-kind')
})

test('an interpreter that is not configured is said plainly, and the text stays saved', () => {
  const failure = describeRequestFailure(412, { error: { code: 'PRECONDITION_REQUIRED', details: { reason: 'brief-interpreter-unavailable' } } })
  assert.match(failure.message, /texto ficou salvo/)
  assert.equal(describeRequestFailure(401, null).kind, 'session-expired')
})
