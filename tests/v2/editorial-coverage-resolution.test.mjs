import assert from 'node:assert/strict'
import test from 'node:test'

import { proposeSpeechRemoval, speechRemovalRuleId } from '../../src/v2/application/speech-removal-proposal.ts'
import { defineEditorialPhraseRules } from '../../src/v2/application/editorial-phrase-rules.ts'
import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import {
  assertOutputIsProduced, assertReframePlanCoherentWithLayout, assertReframePlanForFill, assertResolutionPlannable, overlayTextOf, parseEditorialPolicyResolution, resolveEditorialPolicies,
} from '../../src/v2/domain/editorial-policy-resolution.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createEditorialRequest } from '../../src/v2/domain/editorial-request.ts'
import { presentPublicDomainError } from '../../src/v2/public-api/error-presenter.ts'
import { W70_BRIEFING, W70_COVERAGE_MODEL_ANSWER, w70Transcript } from './helpers/w70-briefing-fixture.mjs'

const model = (answer) => ({ provider: 'test-double', model: 'stub-1', costBasis: 'subscription', async interpret() { return { text: JSON.stringify(answer) } } })
const VERTICAL = { variantId: 'variant-vertical', id: 'output-vertical', aspectRatio: '9:16' }
const HORIZONTAL = { variantId: 'variant-horizontal', id: 'output-horizontal', aspectRatio: '16:9' }
const MEDIA = {
  transcriptId: 'transcript-1', transcriptLanguage: 'pt', transcriptLanguageBasis: 'detected-from-media', hasSelectedInsert: false, sourceAspectRatio: '1920:1080',
  timelineDurationSeconds: 90, spokenCta: { startSeconds: 40, endSeconds: 44 }, backgroundMusicTrackCount: 0,
}
const proposalsFor = (subjects, requested = []) => subjects.map((subject) => proposeSpeechRemoval(subject, w70Transcript(), { sourceTranscriptId: 'transcript-1', requested }))
/** The rule of a removal Command. `medium` is how its confirmation was made; without it the Command came from the general Command (an explicit cut, never a confirmation). */
const ruleOf = (proposal, alternatives = proposal.alternatives, medium = 'ui-session') => {
  const [rule] = defineEditorialPhraseRules([{ id: proposal.ruleId, label: proposal.label, alternatives }])
  return medium === null ? rule : { ...rule, confirmation: { subject: proposal.subject, medium } }
}

async function w70Request(extra = {}) {
  const { interpretation } = await interpretBriefService({ model: model(W70_COVERAGE_MODEL_ANSWER) })({ briefing: W70_BRIEFING })
  return createEditorialRequest({ briefing: W70_BRIEFING, objective: 'warming', interpretation, ...extra })
}
const ids = (list) => list.map((item) => item.id)

test('ADR-160 coverage W70: the briefing resolves to a policy per output, the written call with its words, and only what the Apollo cannot do blocks', async () => {
  const request = await w70Request()
  const resolution = resolveEditorialPolicies(request, { ...MEDIA, speechRemovalProposals: proposalsFor(['sorteio', 'formulário de inscrição']) }, [VERTICAL, HORIZONTAL])
  const { layout, ctaOverlay } = resolution.policies
  // The vertical output is filled following the face; the horizontal keeps the frame: nothing is "not supported" about either.
  assert.deepEqual(layout.value.perOutput, [
    { variantId: 'variant-vertical', aspectRatio: '9:16', mode: 'fill-following-face' },
    { variantId: 'variant-horizontal', aspectRatio: '16:9', mode: 'source-native' },
  ])
  assert.equal(layout.value.mode, 'source-native', 'the timeline is composed for the outputs that are not filled')
  assert.equal(layout.status, 'applied')
  assert.equal(layout.origin, 'request-briefing')
  assert.equal(layout.rule, 'explicit-request')
  assert.match(layout.reason, /Na vertical, preencha a tela/)
  assert.match(layout.reason, /reframe trajectory of that output/)
  assert.ok(layout.evidenceRefs.some((ref) => /^briefing:\d+-\d+$/.test(ref)))
  // The written call is drawn at the spoken call with the words the briefing quotes.
  assert.deepEqual(ctaOverlay.value, { mode: 'window', startSeconds: 40, endSeconds: 44, anchoredTo: 'spoken-cta', text: 'Trave sua agenda' })
  assert.equal(ctaOverlay.origin, 'request-briefing')
  assert.equal(overlayTextOf(resolution.policies, 'outro texto'), 'Trave sua agenda')
  // What blocks: a zoom (understood, not executed) and the length of the captions (outside the vocabulary), each told in its own item.
  assert.deepEqual(resolution.unsupported.map((item) => [item.policyKey, item.reason]), [['movement', 'not-executable'], ['interpretation', 'outside-vocabulary']])
  assert.match(resolution.unsupported[0].summary, /ainda não aplica zoom/)
  assert.equal(resolution.policies.movement.status, 'unsupported')
  // The two subjects of the speech are asked to be confirmed, with the stretches they would take out, and nothing is cut.
  assert.deepEqual(ids(resolution.openQuestions), ['speech-removal-1', 'speech-removal-2'])
  assert.match(resolution.openQuestions[0].question, /Achei um trecho sobre “sorteio” na fala/)
  // The subject is spoken in a passage (three sentences of the speech), not in three loose sentences.
  assert.match(resolution.openQuestions[0].question, /58,0 s a 79,5 s/)
  assert.match(resolution.openQuestions[0].question, /nada é cortado sem a sua confirmação/)
  assert.match(resolution.openQuestions[0].question, /ajustar onde ele começa e onde termina/)
  assert.match(resolution.openQuestions[0].question, /não diz o idioma da fala/, 'a transcript with no language is searched literally, and the question says so')
  assert.equal(resolution.openQuestions[0].removal.matches.length, 1)
  assert.equal(resolution.openQuestions[0].removal.passages.length, 1)
  assert.equal(resolution.openQuestions[1].removal.matches.length, 1)
  assert.deepEqual(resolution.policies.speechRemovals.value.ruleIds, [])
  assert.equal(resolution.blocked, true)
  // What needs no work is satisfied, and said with what satisfies it.
  assert.deepEqual(resolution.satisfied.map((item) => [item.kind, item.how, item.origin, item.rule]), [
    ['output', 'project-outputs', 'output-spec', 'output-geometry'], ['output', 'project-outputs', 'output-spec', 'output-geometry'],
    ['invariant', 'invariant', 'product-invariant', 'product-invariant'], ['absent', 'default', 'silence-rule', 'minimal-intervention'],
  ])
  assert.match(resolution.satisfied[2].reason, /a cue that cannot be certified is not drawn/)
  assert.match(resolution.satisfied[3].reason, /The Apollo adds no music/)
  assert.doesNotThrow(() => parseEditorialPolicyResolution(JSON.parse(JSON.stringify(resolution))))
  assert.throws(() => assertResolutionPlannable(resolution), (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'editorial-request-blocked')
})

test('ADR-160 coverage W70: the owner confirms the cut by the removal Command, and the questions are gone; the rest of the request still decides', async () => {
  const asked = proposalsFor(['sorteio', 'formulário de inscrição'])
  // The lineage holds the removal Commands whose rules are the proposed ones - the id AND the words.
  const proposals = proposalsFor(['sorteio', 'formulário de inscrição'], asked.map((proposal) => ruleOf(proposal)))
  assert.deepEqual(proposals.map((proposal) => proposal.confirmed), [true, true])
  const confirmed = await w70Request({ requestedRemovals: proposals.map((proposal) => proposal.ruleId) })
  const resolution = resolveEditorialPolicies(confirmed, { ...MEDIA, speechRemovalProposals: proposals }, [VERTICAL, HORIZONTAL])
  assert.deepEqual(resolution.openQuestions, [])
  assert.deepEqual(resolution.policies.speechRemovals.value.ruleIds, proposals.map((proposal) => proposal.ruleId).toSorted())
  assert.deepEqual(resolution.satisfied.filter((item) => item.how === 'confirmed-removal').map((item) => item.kind), ['remove-speech', 'remove-speech'])
  assert.equal(resolution.blocked, true, 'the zoom and the captions length still block: confirmation answers the cut, nothing else')
  // Confirming one of the two leaves the other asked.
  const partly = proposalsFor(['sorteio', 'formulário de inscrição'], [ruleOf(asked[0])])
  const one = await w70Request({ requestedRemovals: [asked[0].ruleId] })
  assert.deepEqual(ids(resolveEditorialPolicies(one, { ...MEDIA, speechRemovalProposals: partly }, [VERTICAL, HORIZONTAL]).openQuestions), ['speech-removal-2'])
  // The id alone confirms nothing: a rule with the proposed id and OTHER words is another cut, and the proposed one is still asked.
  const forged = proposalsFor(['sorteio', 'formulário de inscrição'], asked.map((proposal) => ruleOf(proposal, ['garantia'])))
  assert.deepEqual(forged.map((proposal) => proposal.confirmed), [undefined, undefined])
  const stillAsked = resolveEditorialPolicies(await w70Request({ requestedRemovals: asked.map((proposal) => proposal.ruleId) }), { ...MEDIA, speechRemovalProposals: forged }, [VERTICAL, HORIZONTAL])
  assert.deepEqual(ids(stillAsked.openQuestions), ['speech-removal-1', 'speech-removal-2'])
  // The general Command carries the id and the words a proposal computes (and a Director refusal shows) and still confirms nothing: it is a valid cut, not the answer.
  const general = proposalsFor(['sorteio', 'formulário de inscrição'], asked.map((proposal) => ruleOf(proposal, proposal.alternatives, null)))
  assert.deepEqual(general.map((proposal) => proposal.confirmed), [undefined, undefined])
  const generalResolution = resolveEditorialPolicies(await w70Request({ requestedRemovals: asked.map((proposal) => proposal.ruleId) }), { ...MEDIA, speechRemovalProposals: general }, [VERTICAL, HORIZONTAL])
  assert.deepEqual(ids(generalResolution.openQuestions), ['speech-removal-1', 'speech-removal-2'])
  assert.deepEqual(generalResolution.policies.speechRemovals.value.ruleIds, asked.map((proposal) => proposal.ruleId).toSorted(), 'the explicit cut stays honored by the captions, and still answers no question')
  // A confirmation made for another subject answers that subject only.
  const swapped = proposalsFor(['sorteio'], [{ ...ruleOf(asked[0]), confirmation: { subject: 'formulário de inscrição', medium: 'api-key-scope' } }])
  assert.equal(swapped[0].confirmed, undefined)
  // The same words under another id confirm nothing either.
  const other = proposalsFor(['sorteio'], [defineEditorialPhraseRules([{ id: 'another-rule', label: 'sorteio', alternatives: ['sorteio'] }])[0]])
  assert.equal(other[0].confirmed, undefined)
  assert.equal(asked[0].sourceTranscriptId, 'transcript-1')
})

test('ADR-160 coverage: the rule that answers a cut is the subject\'s own, and the search is the cut\'s own search', () => {
  assert.equal(speechRemovalRuleId('Sorteio'), speechRemovalRuleId('sorteio.'))
  assert.notEqual(speechRemovalRuleId('sorteio'), speechRemovalRuleId('formulário'))
  assert.match(speechRemovalRuleId('sorteio'), /^speech-[a-f0-9]{12}$/)
  const transcript = w70Transcript()
  const phrase = proposeSpeechRemoval('formulário de inscrição', transcript)
  assert.equal(phrase.basis, 'phrase')
  assert.deepEqual(phrase.alternatives.toSorted(), ['formulário', 'formulário de inscrição', 'inscrição'], 'the rule looks for the forms the speech says')
  assert.equal(phrase.matches[0].startSeconds, 58)
  // The whole phrase is not spoken: the words longer than three letters are searched one by one, and the proposal says so.
  const words = proposeSpeechRemoval('sorteio e do formulário de inscrição', transcript)
  assert.equal(words.basis, 'words')
  assert.deepEqual(words.alternatives.toSorted(), ['formulário', 'inscrição', 'sorteio'])
  // The three sentences are one passage of the speech: a block from the first to the last, with its whole text.
  assert.deepEqual(words.matches.map((match) => [match.startSeconds, match.endSeconds]), [[58, 79.5]])
  assert.equal(words.passages[0].text, 'Quem quiser participar do sorteio da sessão individual preenche o formulário de inscrição. O resultado do sorteio sai na sexta. Depois do sorteio, entra na área de membros e no grupo.')
  // A subject nobody says has no candidate.
  const none = proposeSpeechRemoval('garantia', transcript)
  assert.deepEqual(none.matches, [])
  assert.equal(none.searchable, true)
  assert.equal(proposeSpeechRemoval('um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis dezessete', transcript).searchable, false)
  // Without segments the sentences are found from the marks of the words, and the passage is still whole sentences.
  const bare = proposeSpeechRemoval('sorteio', { words: transcript.words })
  assert.equal(bare.matches.length, 1)
  assert.equal(bare.passages[0].boundary, 'sentence')
  assert.equal(bare.matches[0].startSeconds, 58)
})

test('ADR-160 coverage: a cut that finds nothing, cannot be searched, or has no transcript is a question that says so, never a silent skip', async () => {
  const request = await w70Request()
  const none = proposeSpeechRemoval('sorteio', { words: [], segments: [] })
  const long = { ...none, subject: 'formulário de inscrição', searchable: false }
  const resolved = resolveEditorialPolicies(request, { ...MEDIA, speechRemovalProposals: [none, long] }, [VERTICAL, HORIZONTAL])
  assert.match(resolved.openQuestions[0].question, /Não achei na fala nada sobre “sorteio”/)
  assert.match(resolved.openQuestions[1].question, /longo demais/)
  const noTranscript = resolveEditorialPolicies(request, MEDIA, [VERTICAL, HORIZONTAL])
  assert.deepEqual(ids(noTranscript.openQuestions), ['speech-removal-1', 'speech-removal-2'])
  assert.match(noTranscript.openQuestions[0].question, /ainda não tem transcrição/)
})

test('ADR-160 coverage: an output the request asks for and the project does not have is a question; one it has is satisfied, whatever the shape is called', async () => {
  const request = createEditorialRequest({ directives: [
    { id: 'a', kind: 'output', value: 'vertical' }, { id: 'b', kind: 'output', value: 'square' }, { id: 'c', kind: 'output', value: 'aspect', param: '16:9' },
    { id: 'd', kind: 'output', value: 'aspect', param: '21:9' },
  ] })
  const resolved = resolveEditorialPolicies(request, MEDIA, [VERTICAL, HORIZONTAL])
  assert.deepEqual(resolved.satisfied.map((item) => item.directiveId), ['a', 'c'])
  assert.deepEqual(ids(resolved.openQuestions), ['output-missing-square', 'output-missing-21x9'])
  assert.match(resolved.openQuestions[0].question, /O pedido quer a versão quadrada, e este projeto não tem uma saída assim\. Quer criar essa saída\?/)
  assert.match(resolved.openQuestions[1].question, /a versão 21:9/)
  assert.equal(resolved.blocked, true)
  // A project with no output at all has none of them.
  assert.deepEqual(ids(resolveEditorialPolicies(request, MEDIA, []).openQuestions), ['output-missing-vertical', 'output-missing-square', 'output-missing-16x9', 'output-missing-21x9'])
  // The same request over two outputs that are what it asked is not blocked by it.
  const both = createEditorialRequest({ directives: [{ id: 'a', kind: 'output', value: 'vertical' }, { id: 'c', kind: 'output', value: 'horizontal' }] })
  assert.equal(resolveEditorialPolicies(both, MEDIA, [VERTICAL, HORIZONTAL]).blocked, false)
})

test('ADR-160 coverage: the layout of an output follows the most specific reference; fill, native and backdrop each have their rule, and the questions name the output', () => {
  const resolve = (directives, outputs = [VERTICAL, HORIZONTAL], media = MEDIA) => resolveEditorialPolicies(createEditorialRequest({ directives }), media, outputs)
  // An aspect ratio beats a shape, a shape beats "all".
  const specific = resolve([
    { id: 'a', kind: 'output-layout', value: 'fit-with-backdrop', param: 'all' }, { id: 'b', kind: 'output-layout', value: 'fill-following-face', param: 'vertical' },
    { id: 'c', kind: 'output-layout', value: 'source-native', param: '16:9' },
  ])
  assert.deepEqual(specific.policies.layout.value.perOutput.map((entry) => entry.mode), ['fill-following-face', 'source-native'])
  assert.equal(specific.blocked, false)
  // "fill-crop" for every output fills those whose frame differs from the source; the one that is the source's own is the source.
  const everyOutput = resolve([{ id: 'a', kind: 'layout', value: 'fill-crop' }])
  assert.deepEqual(everyOutput.policies.layout.value.perOutput.map((entry) => entry.mode), ['fill-following-face', 'source-native'])
  assert.equal(everyOutput.blocked, false)
  // Source frame kept on an output that is not the source's shape: asked, with the output named.
  const mismatch = resolve([{ id: 'a', kind: 'output-layout', value: 'source-native', param: 'vertical' }])
  assert.deepEqual(ids(mismatch.openQuestions), ['output-layout-source-native-mismatch-variant-vertical'])
  assert.match(mismatch.openQuestions[0].question, /mas a gravação \(1920:1080\) não tem o formato dessa saída \(9:16\)/)
  // A layout for an output the project does not have.
  const missing = resolve([{ id: 'a', kind: 'output-layout', value: 'fill-following-face', param: 'square' }])
  assert.deepEqual(ids(missing.openQuestions), ['output-layout-without-output-square'])
  // Every output filled: the plan is composed with the whole frame over a backdrop (the clips the trajectory cannot follow are shown whole).
  const allFilled = resolve([{ id: 'a', kind: 'output-layout', value: 'fill-following-face', param: 'all' }], [VERTICAL])
  assert.equal(allFilled.policies.layout.value.mode, 'fit-with-backdrop')
  // With no layout directive at all the policy is exactly the one that always was: no per-output field, so nothing about old requests moved.
  const silent = resolve([])
  assert.equal('perOutput' in silent.policies.layout.value, false)
  assert.equal(silent.policies.layout.origin, 'silence-rule')
  assert.equal(silent.satisfied, undefined)
  assert.ok(!('satisfied' in silent))
})

test('ADR-160 coverage: the render of a filled output needs the reframe plan of that output, and says what is missing; other outputs and cuts of the source ask nothing', async () => {
  const request = await w70Request()
  const filled = resolveEditorialPolicies(request, { ...MEDIA, speechRemovalProposals: proposalsFor(['sorteio', 'formulário de inscrição']) }, [VERTICAL, HORIZONTAL])
  assert.throws(() => assertReframePlanForFill(filled, 'variant-vertical', false), (error) =>
    error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'reframe-plan-required' && error.details.variantId === 'variant-vertical')
  assert.doesNotThrow(() => assertReframePlanForFill(filled, 'variant-vertical', true))
  assert.doesNotThrow(() => assertReframePlanForFill(filled, 'variant-horizontal', false))
  assert.doesNotThrow(() => assertReframePlanForFill(null, 'variant-vertical', false))
  assert.doesNotThrow(() => assertReframePlanForFill(undefined, 'variant-vertical', false))
  // The reason crosses to the owner with the output it is about, and nothing else of the details.
  const published = presentPublicDomainError(
    (() => { try { assertReframePlanForFill(filled, 'variant-vertical', false) } catch (error) { return error } })(), 'request-1')
  assert.deepEqual(published.error.details, { reason: 'reframe-plan-required', variantId: 'variant-vertical' })
})

test('ADR-160 coverage: the owner is told why the Director stopped in the Apollo\'s words, with the cut to confirm; nothing else of the details crosses', async () => {
  const request = await w70Request()
  const resolution = resolveEditorialPolicies(request, { ...MEDIA, speechRemovalProposals: proposalsFor(['sorteio', 'formulário de inscrição']) }, [VERTICAL, HORIZONTAL])
  let refusal
  try { assertResolutionPlannable(resolution) } catch (error) { refusal = error }
  const leaky = new DomainError(refusal.code, refusal.message, { ...refusal.details, secret: 'C:/Users/someone/token.txt' })
  const published = presentPublicDomainError(leaky, 'request-2')
  const { details } = published.error
  assert.equal(details.reason, 'editorial-request-blocked')
  assert.deepEqual(details.blockers.map((blocker) => [blocker.kind, blocker.id]), [
    ['unsupported', 'd1'], ['unsupported', 'u1'], ['question', 'speech-removal-1'], ['question', 'speech-removal-2'],
  ])
  assert.match(details.blockers[0].text, /ainda não aplica zoom/)
  const cut = details.blockers[2].removal
  assert.equal(cut.ruleId, speechRemovalRuleId('sorteio'))
  assert.deepEqual(cut.alternatives, ['sorteio'])
  assert.equal(cut.matches.length, 1)
  assert.equal(cut.passages.length, 1)
  assert.equal(cut.passages[0].mentions.length, 3, 'the mentions that anchor the passage cross whole')
  assert.equal(cut.search.matching, 'literal')
  assert.equal(cut.search.policy.origin, 'technical-search-parameter')
  assert.doesNotMatch(JSON.stringify(published), /token\.txt|someone/)
  // A field that is not text of the Apollo's, or an id that is not an id, does not cross.
  const hostile = presentPublicDomainError(new DomainError(refusal.code, refusal.message, {
    reason: 'editorial-request-blocked', unsupported: [{ directiveId: 'a b', summary: 'x' }, { directiveId: 'ok', summary: 'a\u0000b' }], openQuestions: [{ id: '../x', question: 'q' }],
  }), 'request-3')
  assert.deepEqual(hostile.error.details, { reason: 'editorial-request-blocked' })
})

test('ADR-160 coverage: the text of the written call comes from the request, and a different text in the desired action is a question, never a pick', () => {
  const action = createDesiredAction({ objective: 'sale', desiredAction: { destination: { type: 'url', value: 'https://destination.example/action' }, visualCta: '<texto do campo>' } })
  const same = createEditorialRequest({ objective: 'sale', desiredAction: action, directives: [{ id: 'a', kind: 'cta-text', value: 'set', param: '<TEXTO DO CAMPO>' }, { id: 'b', kind: 'cta', value: 'overlay-closing' }] })
  assert.equal(resolveEditorialPolicies(same, { ...MEDIA, closingSentenceStartSeconds: 80 }, []).openQuestions.length, 0)
  const different = createEditorialRequest({ objective: 'sale', desiredAction: action, directives: [{ id: 'a', kind: 'cta-text', value: 'set', param: '<outro texto>' }, { id: 'b', kind: 'cta', value: 'overlay-closing' }] })
  const resolved = resolveEditorialPolicies(different, { ...MEDIA, closingSentenceStartSeconds: 80 }, [])
  assert.deepEqual(ids(resolved.openQuestions), ['cta-text-conflict'])
  assert.match(resolved.openQuestions[0].question, /Qual dos dois vale\?/)
  // The words alone, without a desired action, draw nothing until the speech says where: the text is the request's, the place is the speech's.
  const onlyText = createEditorialRequest({ directives: [{ id: 'a', kind: 'cta-text', value: 'set', param: '<texto>' }] })
  assert.deepEqual(resolveEditorialPolicies(onlyText, MEDIA, []).policies.ctaOverlay.value, { mode: 'window', startSeconds: 40, endSeconds: 44, anchoredTo: 'spoken-cta', text: '<texto>' })
  assert.deepEqual(ids(resolveEditorialPolicies(onlyText, { ...MEDIA, spokenCta: undefined }, []).openQuestions), ['cta-overlay-placement-unknown'])
})

test('ADR-160 coverage: music the video already has is something the Apollo cannot take out - it is not "satisfied by default"', () => {
  const request = createEditorialRequest({ directives: [{ id: 'a', kind: 'absent', value: 'music' }, { id: 'b', kind: 'absent', value: 'effects' }, { id: 'c', kind: 'absent', value: 'transitions' }] })
  const clean = resolveEditorialPolicies(request, MEDIA, [])
  assert.deepEqual(clean.satisfied.map((item) => item.how), ['default', 'default', 'default'])
  assert.equal(clean.blocked, false)
  const withMusic = resolveEditorialPolicies(request, { ...MEDIA, backgroundMusicTrackCount: 1 }, [])
  assert.deepEqual(withMusic.unsupported.map((item) => item.directiveId), ['a'])
  assert.match(withMusic.unsupported[0].summary, /o Apollo ainda não tira música/)
  assert.deepEqual(withMusic.satisfied.map((item) => item.directiveId), ['b', 'c'])
  assert.equal(withMusic.blocked, true)
})

test('ADR-160 coverage: a stored resolution that names a satisfied item is read back exactly, and one that was changed is refused', async () => {
  const request = await w70Request()
  const resolution = resolveEditorialPolicies(request, { ...MEDIA, speechRemovalProposals: proposalsFor(['sorteio', 'formulário de inscrição']) }, [VERTICAL, HORIZONTAL])
  const stored = JSON.parse(JSON.stringify(resolution))
  assert.equal(parseEditorialPolicyResolution(stored).policyResolutionHash, resolution.policyResolutionHash)
  const forged = structuredClone(stored)
  forged.satisfied[0].reason = 'changed'
  assert.throws(() => parseEditorialPolicyResolution(forged), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const stray = structuredClone(stored)
  stray.satisfied[0].origin = 'workspace-policy'
  assert.throws(() => parseEditorialPolicyResolution(stray), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const empty = structuredClone(stored)
  empty.satisfied = []
  assert.throws(() => parseEditorialPolicyResolution(empty), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('ADR-160 coverage: a request for the one output the plan serves is read like a structured field - none of it is dropped, with one output or with two', () => {
  const overrides = (variantId) => ({ [variantId]: [
    { id: 'o1', kind: 'remove-speech', value: 'about', param: 'sorteio' }, { id: 'o2', kind: 'cta-text', value: 'set', param: 'Outro texto' },
    { id: 'o3', kind: 'output', value: 'vertical' }, { id: 'o4', kind: 'absent', value: 'music' },
    { id: 'o5', kind: 'output-layout', value: 'fill-following-face', param: 'all' },
  ] })
  const media = { ...MEDIA, backgroundMusicTrackCount: 1, speechRemovalProposals: proposalsFor(['sorteio']) }
  const field = createEditorialRequest({ objective: 'warming', directives: overrides('x').x })
  const byField = resolveEditorialPolicies(field, media, [{ variantId: 'v1', id: 'o1', aspectRatio: '16:9' }])
  const byOverride = resolveEditorialPolicies(createEditorialRequest({ objective: 'warming', variantOverrides: overrides('v1') }), media, [{ variantId: 'v1', id: 'o1', aspectRatio: '16:9' }])
  // One output: the same things happen, and each is attributed to the override.
  assert.deepEqual(ids(byOverride.openQuestions), ids(byField.openQuestions))
  assert.deepEqual(ids(byOverride.openQuestions), ['output-missing-vertical', 'output-not-asked-v1', 'speech-removal-1'])
  assert.deepEqual(byOverride.unsupported.map((item) => item.directiveId), ['o4'])
  assert.equal(byOverride.policies.ctaOverlay.value.text, 'Outro texto')
  assert.equal(byOverride.policies.ctaOverlay.origin, 'request-field')
  assert.match(byOverride.policies.ctaOverlay.reason, /Requested for output variant v1 as a structured field/)
  assert.deepEqual(byOverride.policies.layout.value.perOutput.map((entry) => entry.mode), ['source-native'])
  assert.equal(byOverride.blocked, true)
  // Two outputs: a plan that is one for both cannot do what one of them alone asks, so each is listed as not executable - never dropped.
  const two = resolveEditorialPolicies(createEditorialRequest({ objective: 'warming', variantOverrides: overrides('v1') }), media, [{ variantId: 'v1', id: 'o1', aspectRatio: '16:9' }, VERTICAL])
  assert.deepEqual(two.unsupported.map((item) => item.directiveId), ['o1', 'o2', 'o3', 'o4', 'o5'])
  assert.ok(two.unsupported.every((item) => item.reason === 'not-executable' && item.source === 'variant-override'))
  assert.match(two.unsupported[0].summary, /O plano do vídeo é um só para as 2 saídas/)
  // A request for an output the project does not have is listed too.
  const missing = resolveEditorialPolicies(createEditorialRequest({ objective: 'warming', variantOverrides: overrides('v-other') }), media, [{ variantId: 'v1', id: 'o1', aspectRatio: '16:9' }])
  assert.deepEqual(missing.unsupported.map((item) => item.directiveId), ['o1', 'o2', 'o3', 'o4', 'o5'])
  assert.match(missing.unsupported[0].summary, /uma saída que este projeto não tem/)
})

test('ADR-160 coverage: the words of the written call are the briefing\'s own, with its case and accents, whatever the model gave back', async () => {
  const briefing = 'Mostre o texto "Agende já" na tela quando ele falar da agenda.'
  const read = (param) => interpretBriefService({ model: model({ directives: [
    { kind: 'cta', value: 'overlay-at-spoken-cta', param: null, quote: 'quando ele falar da agenda' },
    { kind: 'cta-text', value: 'set', param, quote: 'Mostre o texto "Agende já" na tela' },
  ], unsupported: [], questions: [], coverage: [{ topic: 'context', quote: 'Mostre o texto "Agende já" na tela quando ele falar da agenda.' }] }) })({ briefing })
  for (const given of ['AGENDE JA', 'agende já', '"Agende já"', ' agende  JÁ ']) {
    const { interpretation } = await read(given)
    assert.equal(interpretation.directives.find((item) => item.kind === 'cta-text').param, 'Agende já', given)
    const resolved = resolveEditorialPolicies(createEditorialRequest({ briefing, objective: 'warming', interpretation }), MEDIA, [{ variantId: 'v1', id: 'o1', aspectRatio: '16:9' }])
    assert.equal(resolved.policies.ctaOverlay.value.text, 'Agende já', given)
  }
  // Words the briefing does not say are not a call: the directive becomes an unsupported item.
  const { interpretation } = await read('Compre agora')
  assert.equal(interpretation.directives.some((item) => item.kind === 'cta-text'), false)
  assert.equal(interpretation.unsupported.length, 1)
  // The subject to cut is the owner's words too.
  const cut = await interpretBriefService({ model: model({ directives: [{ kind: 'remove-speech', value: 'about', param: 'sorteio', quote: 'Tire o trecho que fala do Sorteio' }], unsupported: [], questions: [], coverage: [] }) })({ briefing: 'Tire o trecho que fala do Sorteio.' })
  assert.equal(cut.interpretation.directives[0].param, 'Sorteio')
})

test('ADR-160 coverage: a written call asked for, together with a request for no written call, is a question - the text is never dropped in silence', () => {
  for (const value of ['verbal-only', 'none']) {
    const resolved = resolveEditorialPolicies(createEditorialRequest({ objective: 'warming', directives: [{ id: 'f1', kind: 'cta', value }, { id: 'f2', kind: 'cta-text', value: 'set', param: 'Trave sua agenda' }] }), MEDIA, [])
    assert.deepEqual(ids(resolved.openQuestions), ['cta-text-without-overlay'], value)
    assert.match(resolved.openQuestions[0].question, /O pedido quer escrever “Trave sua agenda” na tela e também pede a chamada/)
    assert.equal(resolved.blocked, true)
  }
})

test('ADR-160 coverage: an output the project has and a briefing that names the versions does not ask for is a question; with no versions named, nothing is asked', () => {
  const only = createEditorialRequest({ directives: [{ id: 'a', kind: 'output', value: 'vertical' }] })
  const resolved = resolveEditorialPolicies(only, MEDIA, [VERTICAL, HORIZONTAL])
  assert.deepEqual(ids(resolved.openQuestions), ['output-not-asked-variant-horizontal'])
  assert.match(resolved.openQuestions[0].question, /Este projeto tem uma saída 16:9 que o briefing não pede/)
  // Only the options that exist are offered: keep and produce, or leave this version out of the edition. Nothing is said about taking the output out of the project.
  assert.match(resolved.openQuestions[0].question, /manter e produzir esta saída/)
  assert.match(resolved.openQuestions[0].question, /não produzir esta saída nesta edição/)
  assert.doesNotMatch(resolved.openQuestions[0].question, /tire a saída do projeto/)
  assert.deepEqual(ids(resolveEditorialPolicies(createEditorialRequest({}), MEDIA, [VERTICAL, HORIZONTAL]).openQuestions), [])
  assert.deepEqual(ids(resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'a', kind: 'output', value: 'vertical' }, { id: 'b', kind: 'output', value: 'horizontal' }] }), MEDIA, [VERTICAL, HORIZONTAL]).openQuestions), [])
})

test('ADR-160 coverage: a reframe plan that crops by itself an output whose layout the request keeps is refused; a manual crop and an output that is filled are not', async () => {
  const request = await w70Request()
  const resolution = resolveEditorialPolicies(request, { ...MEDIA, speechRemovalProposals: proposalsFor(['sorteio', 'formulário de inscrição']) }, [VERTICAL, HORIZONTAL])
  const automatic = { ranges: [{ source: 'plan' }] }
  assert.throws(() => assertReframePlanCoherentWithLayout(resolution, 'variant-horizontal', automatic), (error) =>
    error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'reframe-plan-contradicts-layout' && error.details.variantId === 'variant-horizontal')
  assert.doesNotThrow(() => assertReframePlanCoherentWithLayout(resolution, 'variant-vertical', automatic))
  assert.doesNotThrow(() => assertReframePlanCoherentWithLayout(resolution, 'variant-horizontal', { ranges: [{ source: 'manual' }, { source: 'fallback' }] }))
  assert.doesNotThrow(() => assertReframePlanCoherentWithLayout(resolution, 'variant-horizontal', null))
  // A resolution that said nothing about the frames of the outputs allows any plan, as it always did.
  const silent = resolveEditorialPolicies(createEditorialRequest({}), MEDIA, [VERTICAL, HORIZONTAL])
  assert.doesNotThrow(() => assertReframePlanCoherentWithLayout(silent, 'variant-horizontal', automatic))
  assert.doesNotThrow(() => assertReframePlanCoherentWithLayout(null, 'variant-horizontal', automatic))
})

test('ADR-160 coverage: a version the request says not to produce stays in the project, is left out of this edition, answers the question, and its render is refused', () => {
  const request = createEditorialRequest({ directives: [{ id: 'a', kind: 'output', value: 'vertical' }, { id: 'b', kind: 'output', value: 'omit', param: '16:9' }] })
  const resolution = resolveEditorialPolicies(request, MEDIA, [VERTICAL, HORIZONTAL])
  assert.deepEqual(ids(resolution.openQuestions), [], 'the version the request leaves out is not asked about')
  assert.equal(resolution.blocked, false)
  assert.deepEqual(resolution.policies.layout.value.perOutput.map((entry) => [entry.variantId, entry.mode]), [['variant-vertical', 'fit-with-backdrop'], ['variant-horizontal', 'not-produced']])
  assert.ok(resolution.satisfied.some((item) => item.kind === 'output' && item.how === 'project-outputs'), 'the version that is asked for is still satisfied by the project outputs')
  assert.throws(() => assertOutputIsProduced(resolution, 'variant-horizontal'), (error) =>
    error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'output-not-produced' && error.details.variantId === 'variant-horizontal')
  assert.doesNotThrow(() => assertOutputIsProduced(resolution, 'variant-vertical'))
  assert.doesNotThrow(() => assertOutputIsProduced(null, 'variant-horizontal'), 'a resolution that does not name the output asks nothing')
  assert.doesNotThrow(() => assertReframePlanCoherentWithLayout(resolution, 'variant-horizontal', { ranges: [{ source: 'plan' }] }), 'an output that is not produced has no frame to contradict')
  assert.doesNotThrow(() => parseEditorialPolicyResolution(JSON.parse(JSON.stringify(resolution))))
  assert.deepEqual(presentPublicDomainError(new DomainError('PRECONDITION_REQUIRED', 'x', { reason: 'output-not-produced', variantId: 'variant-horizontal', secret: 'C:/x' }), 'request-1').error.details, { reason: 'output-not-produced', variantId: 'variant-horizontal' })
  // A request that leaves out a version the project has not got is a question, not a silent no-op.
  const ghost = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'a', kind: 'output', value: 'omit', param: '4:5' }] }), MEDIA, [VERTICAL, HORIZONTAL])
  assert.deepEqual(ids(ghost.openQuestions), ['output-omit-without-output-4x5'])
  assert.match(ghost.openQuestions[0].question, /não tem uma saída assim/)
})
