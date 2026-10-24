import assert from 'node:assert/strict'
import test from 'node:test'

import { defineEditorialPhraseRules, editorialRulesMatchingSpeech } from '../../src/v2/application/editorial-phrase-rules.ts'
import { confirmSpeechPassages, groupSpeechPassages, SPEECH_PASSAGE_POLICY } from '../../src/v2/application/speech-passage.ts'
import { proposeSpeechRemoval } from '../../src/v2/application/speech-removal-proposal.ts'
import { sameSpeechWord, speechStemmerFor } from '../../src/v2/application/speech-stemming.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { presentPublicDomainError } from '../../src/v2/public-api/error-presenter.ts'
import { cutAdjustmentsOf, cutEndOptions, cutMentionsInRange, cutProposalsOf, cutStartOptions, cutTextOfRange, highlightMentions } from '../../src/v2/ui/editorial-request-view.ts'

/**
 * ADR-160. A subject is spoken in a PASSAGE: the sentences that mention it and the ones between them. The fixture below has the shape of a real case (the
 * segments of a transcript where a talk about a draw and its sign-up form runs for 25 seconds, and only some of its sentences carry the words of the subject).
 * It is the content of a TEST: the product carries none of these words.
 */
const SEGMENTS = [
  { start: 50.0, end: 58.12, text: 'Hoje o conteúdo está todo liberado.' },
  { start: 58.12, end: 60.82, text: 'Você também pode participar de um sorteio.' },
  { start: 60.82, end: 63.5, text: 'Nós vamos sortear uma sessão individual comigo.' },
  { start: 63.5, end: 67.24, text: 'Sim, você terá a oportunidade de ter uma sessão individual comigo,' },
  { start: 67.24, end: 70.92, text: 'mas para isso você precisa preencher um formulário de inscrição' },
  { start: 70.92, end: 72.46, text: 'para participar do sorteio.' },
  { start: 72.46, end: 75.5, text: 'Esse formulário está disponível aqui na área de membros' },
  { start: 75.5, end: 78.9, text: 'ou basta você falar com a minha equipe lá no grupo do WhatsApp' },
  { start: 78.9, end: 81.0, text: 'que a minha equipe vai mandar o formulário para você' },
  { start: 81.0, end: 83.24, text: 'caso você ainda não tenha preenchido.' },
  { start: 83.24, end: 90.0, text: 'Vamos ao próximo módulo.' },
]

/** Words spread evenly over each segment, as a provider that aligns them would give them (no punctuation: the marks are in the segments). */
function transcriptOf(segments = SEGMENTS, extra = {}) {
  const words = segments.flatMap((segment) => {
    const spoken = segment.text.replace(/[.,]/gu, '').split(/\s+/u)
    const step = (segment.end - segment.start) / spoken.length
    return spoken.map((word, index) => ({ word, start: Math.round((segment.start + index * step) * 1000) / 1000, end: Math.round((segment.start + (index + 1) * step - 0.02) * 1000) / 1000 }))
  })
  return { words, segments: segments.map((segment, id) => ({ id, ...segment })), language: 'pt', ...extra }
}
const CLOSE = (left, right) => Math.abs(left - right) < 0.0011

test('the subject is proposed as ONE passage from the first sentence to the last of the talk, not as the loose sentences that carry the word', () => {
  const proposal = proposeSpeechRemoval('sorteio e do formulário de inscrição', transcriptOf(), { sourceTranscriptId: 'transcript-1' })
  assert.equal(proposal.searchable, true)
  assert.equal(proposal.basis, 'words')
  assert.equal(proposal.passages.length, 1)
  const [passage] = proposal.passages
  assert.equal(passage.startSeconds, 58.12)
  assert.equal(passage.endSeconds, 83.24)
  assert.equal(passage.boundary, 'sentence')
  // The whole text of the talk, every sentence between included.
  assert.equal(passage.text, SEGMENTS.slice(1, 10).map((segment) => segment.text).join(' '))
  assert.match(passage.text, /Esse formulário está disponível/)
  assert.match(passage.text, /caso você ainda não tenha preenchido\.$/)
  // The mentions that anchor it: the draw (as "sorteio" and as "sortear"), the form and the sign-up, wherever they are said.
  assert.deepEqual(passage.mentions.map((mention) => mention.text), ['sorteio', 'sortear', 'formulário', 'inscrição', 'sorteio', 'formulário', 'formulário'])
  assert.ok(passage.mentions.every((mention) => mention.startSeconds >= passage.startSeconds && mention.endSeconds <= passage.endSeconds))
  // What the owner reads in the question is the passage, not three pieces.
  assert.deepEqual(proposal.matches.map((match) => [match.startSeconds, match.endSeconds]), [[58.12, 83.24]])
  assert.equal(proposal.sourceTranscriptId, 'transcript-1')
  // The limits within which a person may move it: the speech on both sides, since it is the only passage.
  assert.deepEqual(passage.limits, { earliestStartSeconds: 50, latestEndSeconds: 90 })
  assert.deepEqual(proposal.search.policy, SPEECH_PASSAGE_POLICY)
  assert.equal(proposal.search.policy.origin, 'technical-search-parameter')
  assert.equal(proposal.search.matching, 'stem')
  assert.equal(proposal.search.lexicon, 'pt-endings/v2')
  assert.equal(proposal.search.notice, undefined)
})

test('the request as two subjects finds each its own passage; together they are the whole talk', () => {
  const draw = proposeSpeechRemoval('sorteio', transcriptOf())
  const form = proposeSpeechRemoval('formulário de inscrição', transcriptOf())
  assert.deepEqual(draw.matches.map((match) => [match.startSeconds, match.endSeconds]), [[58.12, 72.46]])
  // The phrase "formulário de inscrição" is spoken once, in the sentence of 63.5-72.46: that is the subject. Its words alone do not call the sentences that only share one
  // (the person can extend the end to the rest of the talk, within the limits).
  assert.deepEqual(form.matches.map((match) => [match.startSeconds, match.endSeconds]), [[63.5, 72.46]])
  assert.deepEqual(form.passages[0].mentions.map((mention) => mention.text), ['formulário de inscrição'])
  assert.equal(draw.basis, 'phrase', 'a subject of one word is the phrase')
  assert.equal(form.basis, 'phrase', 'the whole subject is spoken')
})

test('a word is the same subject in its variations: sorteio, sortear, sorteado, sorteios; formulário and formulários', () => {
  const stemmer = speechStemmerFor('pt-BR')
  assert.equal(stemmer.id, 'pt-endings/v2')
  for (const variation of ['sorteio', 'sorteios', 'sortear', 'sorteado', 'sorteados', 'sorteia', 'sorteamos']) {
    assert.ok(sameSpeechWord(stemmer, variation, 'sorteio'), variation)
  }
  assert.ok(sameSpeechWord(stemmer, 'formularios', 'formulario'))
  assert.ok(sameSpeechWord(stemmer, 'inscricoes', 'inscricao'))
  // Not the same: another word, a longer word that only starts with it, a short word.
  assert.equal(sameSpeechWord(stemmer, 'sorte', 'sorteio'), false)
  assert.equal(sameSpeechWord(stemmer, 'casamento', 'casa'), false)
  assert.equal(sameSpeechWord(stemmer, 'sessao', 'sorteio'), false)
  assert.equal(sameSpeechWord(stemmer, 'dia', 'dias'), false, 'three letters or fewer are compared as spoken')
  // Deterministic: the same word is always the same stem.
  assert.equal(stemmer.stem('sorteado'), stemmer.stem('sorteado'))

  const text = 'Hoje teremos o sorteio. O sorteado recebe um prêmio. Quem foi sorteada fala conosco. Vários sorteios aconteceram.'
  const segments = text.split('. ').map((sentence, index) => ({ start: index * 4, end: index * 4 + 3.5, text: sentence.endsWith('.') ? sentence : `${sentence}.` }))
  const proposal = proposeSpeechRemoval('sorteio', transcriptOf(segments))
  assert.deepEqual(proposal.passages.flatMap((passage) => passage.mentions.map((mention) => mention.text)), ['sorteio', 'sorteado', 'sorteada', 'sorteios'])
  assert.equal(proposal.passages.length, 1)
  // The rule of the cut looks for the forms the speech actually says (at most eight), and each passage holds one of them.
  assert.ok(proposal.alternatives.length <= 8)
  assert.ok(proposal.alternatives.includes('sorteio'))
})

test('a language the Apollo has no lexicon for is searched literally, and the proposal says so', () => {
  const spoken = [{ start: 0, end: 3, text: 'Wir machen eine Verlosung.' }, { start: 3, end: 6, text: 'Die Verlosungen sind morgen.' }]
  const german = proposeSpeechRemoval('Verlosung', transcriptOf(spoken, { language: 'de' }))
  assert.equal(german.search.matching, 'literal')
  assert.equal(german.search.lexicon, null)
  assert.equal(german.search.language, 'de')
  assert.match(german.search.notice, /ainda não tem variações de palavras para o idioma “de”/)
  assert.deepEqual(german.passages.flatMap((passage) => passage.mentions.map((mention) => mention.text)), ['Verlosung'], 'only the word as spoken: "Verlosungen" is another word')
  // The transcript that records no language is literal too, with its own notice.
  const unknown = proposeSpeechRemoval('sorteio', transcriptOf(SEGMENTS, { language: undefined }))
  assert.equal(unknown.search.matching, 'literal')
  assert.equal(unknown.search.language, null)
  assert.match(unknown.search.notice, /não diz o idioma da fala/)
  assert.deepEqual(unknown.passages.flatMap((passage) => passage.mentions.map((mention) => mention.text)), ['sorteio', 'sorteio'], 'sortear is not looked for')
  // "und" (a provider that could not tell) is no language.
  assert.equal(proposeSpeechRemoval('sorteio', transcriptOf(SEGMENTS, { language: 'und' })).search.matching, 'literal')
  assert.equal(speechStemmerFor('und'), undefined)
  assert.equal(speechStemmerFor(undefined), undefined)
})

test('mentions far apart are separate passages, each with limits that stop at its neighbour; the gap is a named technical policy', () => {
  const far = [
    { start: 0, end: 4, text: 'Falamos do sorteio.' },
    { start: 4, end: 8, text: 'É rápido.' },
    ...Array.from({ length: 6 }, (_, index) => ({ start: 8 + index * 5, end: 13 + index * 5, text: `Assunto número ${index + 1} sem relação.` })),
    { start: 38, end: 42, text: 'No fim, o sorteio de novo.' },
    { start: 42, end: 46, text: 'Tchau.' },
  ]
  const proposal = proposeSpeechRemoval('sorteio', transcriptOf(far))
  assert.equal(proposal.passages.length, 2)
  const [first, second] = proposal.passages
  assert.deepEqual([first.startSeconds, first.endSeconds], [0, 4])
  assert.deepEqual([second.startSeconds, second.endSeconds], [38, 42])
  assert.deepEqual(first.limits, { earliestStartSeconds: 0, latestEndSeconds: 38 }, 'a passage may grow up to its neighbour, never into it')
  assert.deepEqual(second.limits, { earliestStartSeconds: 4, latestEndSeconds: 46 })
  assert.notEqual(first.id, second.id)
  // The same words with a longer reach (the owner adjusts the passage: the parameters are named and recorded) are one passage.
  const wide = groupSpeechPassages({
    ruleId: proposal.ruleId, words: transcriptOf(far).words, segments: transcriptOf(far).segments, mentions: proposal.passages.flatMap((passage) => passage.mentions),
    policy: { ...SPEECH_PASSAGE_POLICY, name: 'speech-passage-adjacency/test', maxGapSeconds: 60, maxGapSentences: 20, maxPassageSeconds: 600, maxMentions: 100 },
  })
  assert.equal(wide.length, 1)
  assert.deepEqual([wide[0].startSeconds, wide[0].endSeconds], [0, 42])
  // The ids are those of these bounds under this rule: another proposal does not reuse them.
  assert.notEqual(wide[0].id, first.id)
})

test('a transcript with no sentence marks is cut in whole segments; with no segments at all, in sentences found from the marks of the words', () => {
  const unmarked = SEGMENTS.map((segment) => ({ ...segment, text: segment.text.replace(/[.,]/gu, '') }))
  const bySegment = proposeSpeechRemoval('formulário', transcriptOf(unmarked))
  assert.equal(bySegment.passages[0].boundary, 'segment')
  assert.deepEqual(bySegment.matches.map((match) => [match.startSeconds, match.endSeconds]), [[67.24, 81]])
  const marked = transcriptOf()
  const withMarks = proposeSpeechRemoval('formulário', { language: 'pt', words: marked.words.map((word, index) => ({ ...word, word: index % 1 === 0 && /preenchido|inscrição|sorteio/u.test(word.word) ? `${word.word}.` : word.word })) })
  assert.equal(withMarks.passages[0].boundary, 'sentence')
  const none = proposeSpeechRemoval('formulário', { language: 'pt', words: transcriptOf(unmarked).words })
  assert.equal(none.passages[0].boundary, 'word', 'no marks at all: only the words themselves')
})

test('a passage is confirmed as proposed unless the person moved it, and only to a boundary of the speech within its limits that keeps its mentions', () => {
  const transcript = transcriptOf()
  const proposal = proposeSpeechRemoval('sorteio e do formulário de inscrição', transcript)
  const [passage] = proposal.passages
  const confirmed = (adjustments) => confirmSpeechPassages({ passages: proposal.passages, words: transcript.words, segments: transcript.segments, adjustments }).confirmed
  // No adjustment: the proposed bounds, not adjusted.
  assert.deepEqual(confirmed(undefined).map(({ id, ...rest }) => rest), [{ startSeconds: 58.12, endSeconds: 83.24, proposedStartSeconds: 58.12, proposedEndSeconds: 83.24, adjusted: false }])
  assert.deepEqual(confirmed([]).map((item) => item.adjusted), [false])
  // Naming the proposed bounds is not an adjustment.
  assert.equal(confirmed([{ passageId: passage.id, startSeconds: 58.12, endSeconds: 83.24 }])[0].adjusted, false)
  // Inside the limits, on segment boundaries: the passage starts one segment earlier and ends one segment earlier... as long as every mention stays.
  const ends = confirmed([{ passageId: passage.id, startSeconds: 50, endSeconds: 81 }])[0]
  assert.deepEqual([ends.startSeconds, ends.endSeconds, ends.adjusted, ends.proposedStartSeconds, ends.proposedEndSeconds], [50, 81, true, 58.12, 83.24])
  // On the boundary of a WORD.
  const word = transcript.words.find((item) => item.word === 'preenchido')
  assert.equal(confirmed([{ passageId: passage.id, startSeconds: 58.12, endSeconds: word.end }])[0].endSeconds, word.end)
  // The value is snapped to the exact boundary of the transcript.
  assert.equal(confirmed([{ passageId: passage.id, startSeconds: 58.1204, endSeconds: 83.2396 }])[0].adjusted, false)

  const refused = (adjustment, pattern) => assert.throws(() => confirmed([adjustment]), (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && pattern.test(error.message), JSON.stringify(adjustment))
  refused({ passageId: passage.id, startSeconds: 58.5, endSeconds: 83.24 }, /start of a word or of a segment/)
  refused({ passageId: passage.id, startSeconds: 58.12, endSeconds: 83.5 }, /end of a word or of a segment/)
  refused({ passageId: passage.id, startSeconds: 58.12, endSeconds: 91 }, /end of a word or of a segment/)
  refused({ passageId: passage.id, startSeconds: 60.82, endSeconds: 83.24 }, /keep every mention/)
  refused({ passageId: passage.id, startSeconds: 58.12, endSeconds: 78.9 }, /keep every mention/)
  refused({ passageId: passage.id, startSeconds: 83.24, endSeconds: 58.12 }, /end after it starts/)
  refused({ passageId: 'passage-0000000000', startSeconds: 58.12, endSeconds: 83.24 }, /does not have/)
  refused({ passageId: passage.id, startSeconds: Number.NaN, endSeconds: 83.24 }, /must carry/)
  assert.throws(() => confirmed([{ passageId: passage.id, startSeconds: 58.12, endSeconds: 83.24 }, { passageId: passage.id, startSeconds: 58.12, endSeconds: 83.24 }]), (error) => error.code === 'INVALID_ARGUMENT')
})

test('two passages cannot be moved into one another', () => {
  const far = [
    { start: 0, end: 4, text: 'Falamos do sorteio.' },
    ...Array.from({ length: 6 }, (_, index) => ({ start: 4 + index * 5, end: 9 + index * 5, text: `Assunto número ${index + 1} sem relação.` })),
    { start: 34, end: 38, text: 'No fim, o sorteio de novo.' },
  ]
  const transcript = transcriptOf(far)
  const proposal = proposeSpeechRemoval('sorteio', transcript)
  const [first, second] = proposal.passages
  const move = (adjustment) => confirmSpeechPassages({ passages: proposal.passages, words: transcript.words, segments: transcript.segments, adjustments: [adjustment] }).confirmed
  assert.equal(move({ passageId: first.id, startSeconds: 0, endSeconds: 29 })[0].endSeconds, 29)
  assert.throws(() => move({ passageId: first.id, startSeconds: 0, endSeconds: 38 }), (error) => /beyond its limits/.test(error.message))
  assert.equal(move({ passageId: second.id, startSeconds: 24, endSeconds: 38 })[1].startSeconds, 24)
  assert.throws(() => move({ passageId: second.id, startSeconds: 0, endSeconds: 38 }), (error) => /beyond its limits/.test(error.message))
})

test('the confirmation of a proposal is read back only from a confirmation that holds every mention', () => {
  const transcript = transcriptOf()
  const proposal = proposeSpeechRemoval('formulário', transcript)
  const rule = (confirmation) => ({
    ...defineEditorialPhraseRules([{ id: proposal.ruleId, label: proposal.label, alternatives: [...proposal.alternatives] }])[0],
    ...(confirmation ? { confirmation } : {}),
  })
  const record = (startSeconds, endSeconds) => ({
    subject: 'formulário', medium: 'ui-session',
    passages: [{ id: 'passage-x', startSeconds, endSeconds, proposedStartSeconds: startSeconds, proposedEndSeconds: endSeconds, adjusted: false }],
    search: { matching: 'stem', language: 'pt', lexicon: 'pt-endings/v2', policy: { name: 'x', maxGapSeconds: 1, maxGapSentences: 1, maxSentenceSeconds: 1 } },
  })
  const ask = (requested) => proposeSpeechRemoval('formulário', transcript, { requested }).confirmed
  assert.equal(ask([rule(undefined)]), undefined)
  assert.equal(ask([rule({ subject: 'formulário', medium: 'ui-session' })]), true, 'a confirmation from before passages answers the phrase')
  assert.equal(ask([rule(record(63.5, 83.24))]), true)
  assert.equal(ask([rule(record(63.5, 78))]), undefined, 'the cut left a mention of the subject out: it is asked again')
})

test('the refusal of the Director carries the passages whole, the limits and the way the search was made; what is not text of the Apollo\'s does not cross', () => {
  const proposal = proposeSpeechRemoval('sorteio e do formulário de inscrição', transcriptOf(), { sourceTranscriptId: 'transcript-1' })
  const details = {
    reason: 'editorial-request-blocked',
    openQuestions: [{ id: 'speech-removal-1', question: 'Achei um trecho.', removal: proposal }],
  }
  const published = presentPublicDomainError(new DomainError('PRECONDITION_REQUIRED', 'blocked', details), 'request-1')
  const [blocker] = published.error.details.blockers
  assert.equal(blocker.removal.passages.length, 1)
  assert.equal(blocker.removal.passages[0].id, proposal.passages[0].id)
  assert.equal(blocker.removal.passages[0].text, proposal.passages[0].text)
  assert.deepEqual(blocker.removal.passages[0].limits, { earliestStartSeconds: 50, latestEndSeconds: 90 })
  assert.equal(blocker.removal.passages[0].mentions.length, 7)
  assert.ok(blocker.removal.passages[0].segments.some((segment) => segment.inPassage) && blocker.removal.passages[0].segments.some((segment) => !segment.inPassage))
  assert.equal(blocker.removal.search.matching, 'stem')
  assert.equal(blocker.removal.search.policy.origin, 'technical-search-parameter')
  // A passage out of shape does not cross, and neither do the fields of it that are not the Apollo's.
  const hostile = presentPublicDomainError(new DomainError('PRECONDITION_REQUIRED', 'blocked', {
    reason: 'editorial-request-blocked',
    openQuestions: [{ id: 'speech-removal-1', question: 'q', removal: { ...proposal, passages: [{ ...proposal.passages[0], id: '../x' }], search: { matching: 'magic' } } }],
  }), 'request-2')
  assert.equal(hostile.error.details.blockers[0].removal.passages, undefined)
  assert.equal(hostile.error.details.blockers[0].removal.search, undefined)
})

test('the screen offers, per passage, the places to start and end it, marks the mentions, and sends only what the person moved', () => {
  const proposal = proposeSpeechRemoval('sorteio e do formulário de inscrição', transcriptOf(), { sourceTranscriptId: 'transcript-1' })
  const published = presentPublicDomainError(new DomainError('PRECONDITION_REQUIRED', 'blocked', {
    reason: 'editorial-request-blocked', openQuestions: [{ id: 'speech-removal-1', question: 'Achei um trecho.', removal: proposal }],
  }), 'request-1')
  const [cut] = cutProposalsOf(published.error.details.blockers)
  assert.equal(cut.passages.length, 1)
  const [passage] = cut.passages
  const starts = cutStartOptions(passage)
  const ends = cutEndOptions(passage)
  // The starts are the segments from the lower limit to the first mention; the ends, from the last mention to the upper limit. Never a place that would drop a mention.
  assert.ok(starts.every((option) => option.seconds <= 58.12 + 0.001 || option.seconds <= passage.mentions[0].startSeconds + 0.001))
  assert.ok(starts.some((option) => option.seconds === 58.12) && starts.some((option) => option.seconds === 50))
  assert.ok(ends.some((option) => option.seconds === 83.24) && ends.some((option) => option.seconds === 90))
  assert.ok(ends.every((option) => option.seconds >= passage.mentions.at(-1).endSeconds - 0.001))
  assert.match(starts[0].label, /^\d+,\d s: “/)
  // Nothing moved: nothing to send. Moved: that passage, by id.
  assert.deepEqual(cutAdjustmentsOf(cut.passages, {}), [])
  assert.deepEqual(cutAdjustmentsOf(cut.passages, { [passage.id]: { startSeconds: 58.12, endSeconds: 83.24 } }), [])
  assert.deepEqual(cutAdjustmentsOf(cut.passages, { [passage.id]: { startSeconds: 58.12, endSeconds: 81 } }), [{ passageId: passage.id, startSeconds: 58.12, endSeconds: 81 }])
  const marked = highlightMentions(passage.text, passage.mentions)
  assert.equal(marked.map((piece) => piece.text).join(''), passage.text)
  assert.deepEqual(marked.filter((piece) => piece.mention).map((piece) => piece.text.trim().replace(/[.,]$/u, '')).filter((text) => text.length > 0).slice(0, 4), ['sorteio.', 'sortear', 'formulário', 'inscrição'].map((text) => text.replace(/\.$/u, '')))
})

test('safe variations only: the pairs that merely look alike are not the same word', () => {
  const pt = speechStemmerFor('pt-BR')
  // Other words that share letters: not joined.
  for (const [left, right] of [['venda', 'vendo'], ['conta', 'contar'], ['conta', 'conto'], ['parte', 'partido'], ['banco', 'bancada'], ['sorte', 'sorteio'], ['venda', 'vender'], ['casa', 'casamento']]) {
    assert.equal(sameSpeechWord(pt, left, right), false, `${left} / ${right}`)
  }
  // The same lemma: the plural, and the forms of one verb.
  for (const [left, right] of [['vender', 'vendido'], ['contar', 'contado'], ['partir', 'partido'], ['venda', 'vendas'], ['formulario', 'formularios'], ['sortear', 'sorteio'], ['sorteio', 'sorteados']]) {
    assert.equal(sameSpeechWord(pt, left, right), true, `${left} / ${right}`)
  }
  const en = speechStemmerFor('en-US')
  assert.equal(sameSpeechWord(en, 'plan', 'plane'), false)
  assert.equal(sameSpeechWord(en, 'plan', 'plans'), true)
  assert.equal(sameSpeechWord(en, 'sell', 'selling'), true)
})

test('when the whole phrase of the subject is spoken, its words alone do not become mentions', () => {
  const spoken = [
    { start: 0, end: 4, text: 'Vamos ver a conta de luz da casa.' },
    { start: 4, end: 8, text: 'Fale com o suporte do plano de saúde.' },
    { start: 8, end: 12, text: 'Aqui o plano de saúde cobre tudo.' },
    { start: 12, end: 16, text: 'O plano do ano que vem é outro.' },
  ]
  const proposal = proposeSpeechRemoval('plano de saúde', transcriptOf(spoken))
  assert.equal(proposal.basis, 'phrase')
  assert.deepEqual(proposal.passages.flatMap((passage) => passage.mentions.map((mention) => mention.text)), ['plano de saúde', 'plano de saúde'], '"plano" alone, in the last sentence, is not the subject')
  assert.ok(proposal.passages.every((passage) => passage.endSeconds <= 12))
  // Not spoken as a phrase: its words are the search, as before.
  const apart = proposeSpeechRemoval('saúde do plano', transcriptOf(spoken))
  assert.equal(apart.basis, 'words')
  assert.ok(apart.passages[0].mentions.length >= 3)
})

test('a chain of mentions is closed by the total reach of the passage and by the number of mentions, both named in the policy', () => {
  // A mention every 10 seconds for five minutes, each with a sentence of its own: every gap is within reach, so only the caps stop the chain.
  const chain = Array.from({ length: 30 }, (_, index) => ({ start: index * 10, end: index * 10 + 9, text: `Fala número ${index + 1} sobre o sorteio.` }))
  const proposal = proposeSpeechRemoval('sorteio', transcriptOf(chain))
  assert.ok(proposal.passages.length >= 3, `one endless passage was proposed: ${proposal.passages.map((passage) => passage.endSeconds - passage.startSeconds).join(', ')}`)
  assert.ok(proposal.passages.every((passage) => passage.endSeconds - passage.startSeconds <= SPEECH_PASSAGE_POLICY.maxPassageSeconds + 10))
  assert.ok(proposal.passages.every((passage) => passage.mentions.length <= SPEECH_PASSAGE_POLICY.maxMentions))
  assert.equal(SPEECH_PASSAGE_POLICY.name, 'speech-passage-adjacency/v2')
  const transcript = transcriptOf(chain)
  const few = groupSpeechPassages({
    ruleId: 'speech-x', words: transcript.words, segments: transcript.segments, mentions: proposal.passages.flatMap((passage) => passage.mentions),
    policy: { ...SPEECH_PASSAGE_POLICY, maxMentions: 2, maxPassageSeconds: 1000 },
  })
  assert.ok(few.every((passage) => passage.mentions.length <= 2) && few.length === 15)
  // A sentence without a mark is closed by the policy too: a transcript whose punctuation is missing for minutes is not one sentence.
  const unmarked = Array.from({ length: 8 }, (_, index) => ({ start: index * 10, end: index * 10 + 10, text: index === 3 ? 'falamos do sorteio.' : `parte ${index} sem marca` }))
  unmarked.push({ start: 80, end: 90, text: 'Fim.' })
  const run = proposeSpeechRemoval('sorteio', transcriptOf(unmarked))
  assert.ok(run.passages[0].endSeconds - run.passages[0].startSeconds <= SPEECH_PASSAGE_POLICY.maxSentenceSeconds + 10, `${run.passages[0].startSeconds}-${run.passages[0].endSeconds}`)
})

test('what a person is shown is sealed: the proposal has a hash that changes with the text, the bounds and the search', () => {
  const base = proposeSpeechRemoval('sorteio', transcriptOf())
  assert.match(base.proposalHash, /^[a-f0-9]{64}$/)
  assert.equal(proposeSpeechRemoval('sorteio', transcriptOf()).proposalHash, base.proposalHash, 'deterministic')
  const edited = SEGMENTS.map((segment) => ({ ...segment, text: segment.text.replace('Nós vamos sortear', 'Nós vamos sortear hoje') }))
  assert.notEqual(proposeSpeechRemoval('sorteio', transcriptOf(edited)).proposalHash, base.proposalHash, 'the text changed')
  assert.notEqual(proposeSpeechRemoval('sorteio', transcriptOf(SEGMENTS, { language: 'de' })).proposalHash, base.proposalHash, 'the search changed')
})

test('a person may choose not to cut a passage: it is kept and recorded; at least one is cut; a kept passage is not adjusted', () => {
  const far = [
    { start: 0, end: 4, text: 'Falamos do sorteio.' },
    ...Array.from({ length: 6 }, (_, index) => ({ start: 4 + index * 5, end: 9 + index * 5, text: `Assunto número ${index + 1} sem relação.` })),
    { start: 34, end: 38, text: 'No fim, o sorteio de novo.' },
  ]
  const transcript = transcriptOf(far)
  const proposal = proposeSpeechRemoval('sorteio', transcript)
  const [first, second] = proposal.passages
  const run = (extra) => confirmSpeechPassages({ passages: proposal.passages, words: transcript.words, segments: transcript.segments, ...extra })
  const kept = run({ discarded: [first.id] })
  assert.deepEqual(kept.confirmed.map((passage) => passage.id), [second.id])
  assert.deepEqual(kept.discarded, [{ id: first.id, startSeconds: first.startSeconds, endSeconds: first.endSeconds }])
  assert.deepEqual(run({}).discarded, [])
  const refused = (extra, pattern) => assert.throws(() => run(extra), (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && pattern.test(error.message), JSON.stringify(extra))
  refused({ discarded: [first.id, second.id] }, /At least one passage must be cut/)
  refused({ discarded: ['passage-0000000000'] }, /must name passages of this proposal/)
  refused({ discarded: [first.id, first.id] }, /each once/)
  refused({ discarded: [first.id], adjustments: [{ passageId: first.id, startSeconds: 0, endSeconds: 4 }] }, /cannot be adjusted/)
  // The read-back: the proposal is answered when every mention is in a passage that was cut or one that was kept on purpose.
  const rule = defineEditorialPhraseRules([{ id: proposal.ruleId, label: proposal.label, alternatives: [...proposal.alternatives] }])[0]
  const record = (passages, discarded) => ({
    subject: 'sorteio', medium: 'ui-session',
    passages: passages.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds, proposedStartSeconds: startSeconds, proposedEndSeconds: endSeconds, adjusted: false })),
    ...(discarded.length > 0 ? { discarded: discarded.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds })) } : {}),
    search: { matching: 'stem', language: 'pt', lexicon: 'pt-endings/v2', policy: { name: 'x', maxGapSeconds: 1, maxGapSentences: 1, maxSentenceSeconds: 1, maxPassageSeconds: 1, maxMentions: 1 } },
  })
  const ask = (confirmation) => proposeSpeechRemoval('sorteio', transcript, { requested: [{ ...rule, confirmation }] }).confirmed
  assert.equal(ask(record([second], [first])), true)
  assert.equal(ask(record([second], [])), undefined, 'a passage that is neither cut nor recorded as kept is still asked')
  // A rule that kept a passage on purpose is not judged by the words of the captions (the subject is in the video where the person kept it).
  assert.deepEqual(editorialRulesMatchingSpeech('o sorteio de novo', [{ ...rule, confirmation: record([second], [first]) }]), [])
  assert.deepEqual(editorialRulesMatchingSpeech('o sorteio de novo', [{ ...rule, confirmation: record([second, first], []) }]), [proposal.ruleId])
})

test('the text a person reads for the bounds chosen is exactly the text that is cut: it follows the segments between them, extended or shortened', () => {
  const sentences = [
    { start: 0, end: 2, text: 'Bem-vindos ao curso.' },
    { start: 2, end: 3, text: 'Hoje falamos de tudo,' },
    { start: 3, end: 4, text: 'e de como vender melhor.' },
    { start: 4, end: 6, text: 'Vender bem exige confiança.' },
    { start: 6, end: 8, text: 'O produto foi vendido' },
    { start: 8, end: 9, text: 'ontem.' },
    { start: 9, end: 11, text: 'Agora vamos ao conteúdo.' },
  ]
  const [passage] = proposeSpeechRemoval('vender', transcriptOf(sentences)).passages
  assert.deepEqual([passage.startSeconds, passage.endSeconds], [2, 9])
  assert.equal(cutTextOfRange(passage, passage.startSeconds, passage.endSeconds), passage.text, 'the proposed bounds read the proposed text')
  assert.deepEqual(cutStartOptions(passage).map((option) => option.seconds), [0, 2, 3], 'from the beginning of the speech to the segment of the first mention')
  assert.deepEqual(cutEndOptions(passage).map((option) => option.seconds), [8, 9, 11], 'from the end of the last mention to the end of the speech')
  assert.equal(cutTextOfRange(passage, 0, 9), 'Bem-vindos ao curso. Hoje falamos de tudo, e de como vender melhor. Vender bem exige confiança. O produto foi vendido ontem.', 'extended')
  assert.equal(cutTextOfRange(passage, 3, 9), 'e de como vender melhor. Vender bem exige confiança. O produto foi vendido ontem.', 'shortened at the start')
  assert.equal(cutTextOfRange(passage, 2, 8), 'Hoje falamos de tudo, e de como vender melhor. Vender bem exige confiança. O produto foi vendido', 'shortened at the end')
  assert.equal(cutTextOfRange(passage, 2, 11), `${passage.text} Agora vamos ao conteúdo.`, 'extended at the end')
  assert.deepEqual(cutMentionsInRange(passage, 3, 8).map((mention) => mention.text), ['vender', 'Vender', 'vendido'])
})
