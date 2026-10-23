import assert from 'node:assert/strict'
import test from 'node:test'

import { proposeSpeechRemoval, speechRemovalRuleId } from '../../src/v2/application/speech-removal-proposal.ts'
import { interpretBriefService } from '../../src/v2/application/interpret-brief.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import {
  assertReframePlanForFill, assertResolutionPlannable, overlayTextOf, parseEditorialPolicyResolution, resolveEditorialPolicies,
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
const proposalsFor = (subjects) => subjects.map((subject) => proposeSpeechRemoval(subject, w70Transcript()))

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
  assert.match(resolution.openQuestions[0].question, /Achei trechos sobre “sorteio” na fala/)
  assert.match(resolution.openQuestions[0].question, /58,0 s a 64,5 s/)
  assert.match(resolution.openQuestions[0].question, /nada é cortado sem a sua confirmação/)
  assert.equal(resolution.openQuestions[0].removal.matches.length, 3)
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
  const proposals = proposalsFor(['sorteio', 'formulário de inscrição'])
  const confirmed = await w70Request({ requestedRemovals: proposals.map((proposal) => proposal.ruleId) })
  const resolution = resolveEditorialPolicies(confirmed, { ...MEDIA, speechRemovalProposals: proposals }, [VERTICAL, HORIZONTAL])
  assert.deepEqual(resolution.openQuestions, [])
  assert.deepEqual(resolution.policies.speechRemovals.value.ruleIds, proposals.map((proposal) => proposal.ruleId).toSorted())
  assert.deepEqual(resolution.satisfied.filter((item) => item.how === 'confirmed-removal').map((item) => item.kind), ['remove-speech', 'remove-speech'])
  assert.equal(resolution.blocked, true, 'the zoom and the captions length still block: confirmation answers the cut, nothing else')
  // Confirming one of the two leaves the other asked.
  const one = await w70Request({ requestedRemovals: [proposals[0].ruleId] })
  assert.deepEqual(ids(resolveEditorialPolicies(one, { ...MEDIA, speechRemovalProposals: proposals }, [VERTICAL, HORIZONTAL]).openQuestions), ['speech-removal-2'])
})

test('ADR-160 coverage: the rule that answers a cut is the subject\'s own, and the search is the cut\'s own search', () => {
  assert.equal(speechRemovalRuleId('Sorteio'), speechRemovalRuleId('sorteio.'))
  assert.notEqual(speechRemovalRuleId('sorteio'), speechRemovalRuleId('formulário'))
  assert.match(speechRemovalRuleId('sorteio'), /^speech-[a-f0-9]{12}$/)
  const transcript = w70Transcript()
  const phrase = proposeSpeechRemoval('formulário de inscrição', transcript)
  assert.equal(phrase.basis, 'phrase')
  assert.deepEqual(phrase.alternatives, ['formulário de inscrição'])
  assert.equal(phrase.matches[0].startSeconds, 58)
  // The whole phrase is not spoken: the words longer than three letters are searched one by one, and the proposal says so.
  const words = proposeSpeechRemoval('sorteio e do formulário de inscrição', transcript)
  assert.equal(words.basis, 'words')
  assert.deepEqual(words.alternatives, ['sorteio', 'formulário', 'inscrição'])
  assert.deepEqual(words.matches.map((match) => [match.startSeconds, match.endSeconds]), [[58, 64.5], [66, 69.5], [74, 79.5]])
  // A stretch is the segment the cut would take, whole, with its times; a subject nobody says has no candidate.
  assert.equal(words.matches[1].text, 'O resultado do sorteio sai na sexta.')
  const none = proposeSpeechRemoval('garantia', transcript)
  assert.deepEqual(none.matches, [])
  assert.equal(none.searchable, true)
  assert.equal(proposeSpeechRemoval('um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis dezessete', transcript).searchable, false)
  // Without segments the cut does not expand a match, and the proposal says what the words alone say.
  const bare = proposeSpeechRemoval('sorteio', { words: transcript.words })
  assert.equal(bare.matches.length, 3)
  assert.ok(bare.matches.every((match) => match.endSeconds - match.startSeconds < 1))
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
  assert.equal(cut.matches.length, 3)
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
