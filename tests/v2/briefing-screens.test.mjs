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
  EMPTY_OWNER_CONTEXT,
  EMPTY_PICKS,
  buildCompatibilityContexts,
  contextToken,
  describeMissingContext,
  describeUnevaluated,
  edgeBetween,
  linksKeepingRecipeBack,
  ownerConfirmationAssumptions,
  pathFromPicks,
  pathLinks,
  resolveContextStatements,
} from '../../src/v2/ui/compatibility-context.ts'
import {
  CAPTION_STYLE_LABELS,
  DIRECTIVE_KIND_LABELS,
  DIRECTIVE_VALUE_LABELS,
  ambiguousDirectiveQuestion,
  keepAndAvoidQuestion,
  notExecutableSummary,
  outsideVocabularySummary,
} from '../../src/v2/domain/editorial-request-texts.ts'
import { EDITORIAL_DIRECTIVE_VOCABULARY, EDITORIAL_EXECUTABLE_VALUES } from '../../src/v2/domain/editorial-request.ts'
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
  for (const [file, id] of [['src/app/ProjectsPageClient.tsx', 'project-briefing'], ['src/app/batches/page.tsx', 'batch-briefing']]) {
    const text = source(file)
    const element = text.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>`))?.[0]
    assert.ok(element, `${file} has the briefing field`)
    assert.doesNotMatch(element, /placeholder=/, `${file}: the briefing field has no placeholder`)
    assert.match(element, /aria-required="true"/)
    assert.match(element, new RegExp(`aria-describedby=\\{?\`?"?${id}-guidance`))
    assert.match(text, new RegExp(`<BriefingGuidance[^>]*id="${id}-guidance"`))
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
  assert.equal(buildAnswersBody({}, [{ id: 'q1' }]), null)
  assert.equal(buildAnswersBody({ q1: '   ' }, [{ id: 'q1' }]), null)
  assert.deepEqual(buildAnswersBody({ q1: '  uma   resposta ', q9: 'não é pergunta aberta' }, [{ id: 'q1' }, { id: 'q2' }]), { answers: [{ questionId: 'q1', answer: 'uma resposta' }] })
  // A closed question is answered by choosing one of its choices, never by words; a choice that was not offered is not sent.
  const closed = { id: 'q3', choices: [{ id: 'c1', label: 'a', directive: { kind: 'layout', value: 'source-native' } }, { id: 'c2', label: 'b', directive: { kind: 'layout', value: 'fit-with-backdrop' } }] }
  assert.deepEqual(buildAnswersBody({ q3: 'c2', q1: 'x' }, [closed, { id: 'q1' }]), { answers: [{ questionId: 'q3', choiceId: 'c2' }, { questionId: 'q1', answer: 'x' }] })
  assert.equal(buildAnswersBody({ q3: 'texto livre' }, [closed]), null)
  assert.equal(buildAnswersBody({ q3: 'c9' }, [closed]), null)
})

test('a directive is shown in plain words with its parameter, never with a value the request did not carry', () => {
  assert.deepEqual(describeDirective({ kind: 'opening', value: 'protect-seconds', param: 3 }), { label: 'Abertura', text: 'Proteger os primeiros segundos (3 s)' })
  assert.deepEqual(describeDirective({ kind: 'movement', value: 'none' }), { label: 'Movimento de câmera', text: 'Sem movimento de câmera' })
  assert.deepEqual(describeDirective({ kind: 'caption-language', value: 'set', param: 'xx-YY' }), { label: 'Idioma das legendas', text: 'xx-YY' })
  assert.deepEqual(describeDirective({ kind: 'avoid', value: 'subject', param: 'tema do pedido' }), { label: 'Evitar', text: 'tema do pedido' })
  assert.equal(describeDirective({ kind: 'unknown-kind', value: 'v' }).label, 'unknown-kind')
})

test('an interpreter that is not configured is said plainly, and the text stays saved', () => {
  const failure = describeRequestFailure(412, { error: { code: 'PRECONDITION_REQUIRED', details: { reason: 'brief-interpreter-unavailable' } } })
  assert.match(failure.message, /texto ficou salvo/)
  assert.equal(describeRequestFailure(401, null).kind, 'session-expired')
})

test('the Lotes screen pre-fills nothing and chooses nothing for the owner (ADR-160 F8)', () => {
  const text = source('src/app/batches/page.tsx')
  for (const forbidden of [
    'Composição principal', 'UI_BEST_ACCEPTED_PATH', 'requireProof: false', 'workspace-default', 'batch-default-action', 'workspace-presenter',
    "'discovery'", "useState('pt-BR')", "setLocale('pt-BR')", 'subtitle-style-dynamic', "'cta-primary'", 'brand-kit-current', 'tone: 0.5', 'energy: 0.5',
    'placeholder="Ex.', "new Set(['9:16'])", "useState('25.00')", "useState('12')",
  ]) assert.equal(text.includes(forbidden), false, `the Lotes screen still carries: ${forbidden}`)
  // The state of every choice starts empty.
  assert.match(text, /const \[recipeText, setRecipeText\] = useState\(''\)/)
  assert.match(text, /const \[locale, setLocale\] = useState\(''\)/)
  assert.match(text, /const \[budget, setBudget\] = useState\(''\)/)
  assert.match(text, /const \[formats, setFormats\] = useState<Set<string>>\(new Set\(\)\)/)
  // The recipe path is what the owner picks; the proof is a stated choice that reaches the request.
  assert.match(text, /<RecipePathPicker/)
  assert.match(text, /requireProof: variantRecipePath\.requireProof/)
  assert.match(text, /requireProof: proofChoice === 'with-proof'/)
  // The context of the compatibility map is read from the request of the batch.
  assert.match(text, /\/editorial-request/)
  assert.match(text, /buildCompatibilityContexts\(/)
})

const takes = [
  { id: 'take-a', takeHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64), assignment: { role: 'hook' } },
  { id: 'take-b', takeHash: 'c'.repeat(64), sourceHash: 'd'.repeat(64), assignment: { role: 'body' } },
]
const requestOf = (coverage = []) => ({
  request: { briefing: { text: '<texto do pedido>' }, requestHash: 'e'.repeat(64) },
  interpretation: { interpretationHash: 'f'.repeat(64), coverage: coverage.map(([topic, text]) => ({ topic, excerpt: { text } })) },
})

test('a batch that states nothing sends contexts with nothing in them but the takes themselves', () => {
  const statements = resolveContextStatements(requestOf(), EMPTY_OWNER_CONTEXT)
  assert.deepEqual(statements.map((item) => [item.field, item.source]), [['audience', 'missing'], ['offer', 'missing'], ['persona', 'missing'], ['action', 'missing'], ['locale', 'missing'], ['tone', 'missing']])
  const contexts = buildCompatibilityContexts(takes, statements, requestOf())
  for (const [index, context] of contexts.entries()) {
    assert.deepEqual(Object.keys(context).sort(), ['claims', 'continuityProvides', 'continuityRequires', 'evidenceRefs', 'expectedTakeHash', 'takeId'])
    assert.deepEqual(context.continuityProvides, [`role-${takes[index].assignment.role}`])
    assert.deepEqual(context.evidenceRefs, [takes[index].takeHash, takes[index].sourceHash])
  }
})

test('what the briefing says about the audience and the offer reaches every take, with the evidence of the reading; the owner overrides it; tone is shown, never converted', () => {
  const request = requestOf([['audience', 'o público do pedido'], ['offer', 'a oferta do pedido'], ['tone', 'o tom do pedido']])
  const statements = resolveContextStatements(request, { ...EMPTY_OWNER_CONTEXT, persona: 'quem fala', locale: 'xx-YY' })
  assert.deepEqual(statements.map((item) => item.source), ['briefing', 'briefing', 'owner', 'missing', 'owner', 'briefing'])
  assert.equal(statements.find((item) => item.field === 'tone').informationalOnly, true)
  const contexts = buildCompatibilityContexts(takes, statements, request)
  assert.equal(contexts[0].audienceTags[0], contexts[1].audienceTags[0], 'every take of the batch carries the same statement')
  assert.equal(contexts[0].audienceTags[0], contextToken('audience', 'o público do pedido'))
  assert.equal(contexts[0].locale, 'xx-YY')
  assert.equal('desiredAction' in contexts[0], false, 'nobody stated the action: it is not invented')
  for (const field of ['tone', 'energy', 'visual', 'experiment', 'narrativeTags']) assert.equal(field in contexts[0], false, `${field} is never sent`)
  assert.ok(contexts[0].evidenceRefs.includes(request.request.requestHash) && contexts[0].evidenceRefs.includes(request.interpretation.interpretationHash))
  const overridden = resolveContextStatements(request, { ...EMPTY_OWNER_CONTEXT, audience: 'outro público' })
  assert.equal(overridden[0].source, 'owner')
  assert.equal(contextToken('audience', '  Outro   Público '), contextToken('audience', 'outro público'), 'the identifier ignores case and spacing')
  assert.notEqual(contextToken('audience', 'x'), contextToken('offer', 'x'))
  // The language of the script counts as stated, after the owner's own choice.
  assert.equal(resolveContextStatements(requestOf(), EMPTY_OWNER_CONTEXT, 'xx-YY').find((item) => item.field === 'locale').source, 'script')
})

test('a computed graph says what it could not evaluate, in words', () => {
  const graph = {
    nodes: [{ unspecified: ['personaId', 'tone'] }, {}],
    edges: [{ notEvaluable: [{ check: 'PERSONA_MISMATCH', fields: ['personaId'] }], softScores: [{ dimension: 'tone', score: null }, { dimension: 'duration', score: 0.5 }] }],
    summary: { notEvaluableEdgeCount: 1 },
  }
  assert.deepEqual(describeUnevaluated(graph), { fields: ['persona', 'tom'], checks: ['mesma persona'], dimensions: ['tone'], edgeCount: 1 })
})

test('the recipe path is the one the owner picked, and incomplete until the proof choice and every role are given', () => {
  const picks = { hook: 'n1', body: 'n2', proof: 'n3', cta: 'n4' }
  assert.equal(pathFromPicks(picks, ''), null, 'no proof choice, no path')
  assert.equal(pathFromPicks(EMPTY_PICKS, 'without-proof'), null)
  assert.equal(pathFromPicks({ ...picks, proof: '' }, 'with-proof'), null)
  assert.deepEqual(pathFromPicks(picks, 'with-proof'), { selection: { hookNodeId: 'n1', bodyNodeId: 'n2', proofNodeId: 'n3', ctaNodeId: 'n4' }, orderedNodeIds: ['n1', 'n2', 'n3', 'n4'], requireProof: true })
  assert.deepEqual(pathFromPicks(picks, 'without-proof'), { selection: { hookNodeId: 'n1', bodyNodeId: 'n2', ctaNodeId: 'n4' }, orderedNodeIds: ['n1', 'n2', 'n4'], requireProof: false })
  const graph = { edges: [{ fromNodeId: 'n1', toNodeId: 'n2', decision: 'accepted' }, { fromNodeId: 'n2', toNodeId: 'n4', decision: 'borderline', notEvaluable: [{}] }] }
  assert.deepEqual(edgeBetween(graph, 'n1', 'n2'), { verdict: 'accepted', notEvaluable: false })
  assert.deepEqual(edgeBetween(graph, 'n2', 'n4'), { verdict: 'borderline', notEvaluable: true })
  assert.deepEqual(edgeBetween(graph, 'n1', 'n4'), { verdict: 'absent', notEvaluable: false })
})

test('a link the map left to the owner is named with the context that is missing, confirmed on the screen, and written as an assumption the server reads', () => {
  const picks = { hook: 'n1', body: 'n2', proof: '', cta: 'n4' }
  const owner = ['CONTEXT_NOT_EVALUABLE', 'CONTEXT_REQUIRED_FOR_DECISION']
  const dims = [{ dimension: 'narrative', score: null }, { dimension: 'tone', score: null }, { dimension: 'duration', score: 0.5 }]
  const graph = { edges: [
    { id: 'e12', fromNodeId: 'n1', toNodeId: 'n2', decision: 'accepted', reasonCodes: ['COMPATIBLE'], softScores: dims },
    { id: 'e24', fromNodeId: 'n2', toNodeId: 'n4', decision: 'borderline', reasonCodes: owner, softScores: dims },
  ] }
  const links = pathLinks(picks, 'without-proof', graph)
  assert.deepEqual(links.map((link) => [link.fromRole, link.toRole, link.verdict, link.needsOwner]), [['hook', 'body', 'accepted', false], ['body', 'cta', 'borderline', true]])
  assert.deepEqual(links[1].missingContext, ['temas da narrativa', 'tom'])
  assert.equal(describeMissingContext(links[1]), 'faltou contexto: temas da narrativa, tom')
  // Until the owner confirms it, the link keeps the recipe back; a blocked or absent link keeps it back for good.
  assert.deepEqual(linksKeepingRecipeBack(links, new Set()).map((link) => link.edgeId), ['e24'])
  assert.deepEqual(linksKeepingRecipeBack(links, new Set(['e24'])), [])
  assert.equal(linksKeepingRecipeBack(pathLinks(picks, 'without-proof', { edges: [{ ...graph.edges[0], decision: 'blocked' }, graph.edges[1]] }), new Set(['e12', 'e24'])).length, 1)
  assert.equal(linksKeepingRecipeBack(pathLinks({ ...picks, cta: 'n9' }, 'without-proof', graph), new Set(['e24'])).length, 1, 'no edge between the picks')
  // The confirmation is exactly the assumption the server reads: the code of the roles and the edge it names.
  assert.deepEqual(ownerConfirmationAssumptions(links, new Set()), [])
  const assumptions = ownerConfirmationAssumptions(links, new Set(['e24', 'e12']))
  assert.equal(assumptions.length, 1, 'an accepted link needs no confirmation')
  assert.equal(assumptions[0].code, 'OWNER_CONFIRMED_LINK_BODY_CTA')
  assert.deepEqual(assumptions[0].evidenceRefs, ['e24'])
  assert.match(assumptions[0].statement, /corpo e chamada final/)
})

test('the path picker announces that the objective requires a proof BEFORE the owner picks "no proof", and offers the confirmation of a borderline link', () => {
  const picker = source('src/components/RecipePathPicker.tsx')
  for (const piece of ['proofRequired ? (', 'este objetivo exige uma prova', '<option disabled={proofRequired} value="without-proof">', 'data-testid={`recipe-confirm-${role}`}', 'Eu confirmo que estes dois takes combinam']) {
    assert.ok(picker.includes(piece), piece)
  }
  const batch = source('src/app/batches/page.tsx')
  for (const piece of ['proofRequired={batchObjectiveRequiresProof}', 'ownerConfirmationAssumptions(variantRecipeLinks, confirmedLinks)', 'disabled={busy || !variantRecipePath || variantRecipeLinksKeepingBack.length > 0 || stepNeedsObjective}', 'data-testid="portfolio-needs-owner-links"']) {
    assert.ok(batch.includes(piece), piece)
  }
  assert.match(batch, /data-testid="portfolio-needs-owner-links"/)
})

test('a briefing that cannot be read yet says why in plain words and keeps the text', () => {
  const refused = describeRequestFailure(409, { error: { code: 'PERSISTENCE_CONFLICT' } })
  assert.match(refused.message, /ainda não tem um vídeo e uma saída/)
  assert.match(refused.message, /O texto ficou salvo/)
  // A real version conflict keeps its own message.
  assert.notEqual(describeRequestFailure(409, { error: { code: 'VERSION_CONFLICT' } }).message, refused.message)
})

test('the briefing is the first field after the name, in the project form and in the batch form, with the guidance beside it', () => {
  const project = source('src/app/ProjectsPageClient.tsx')
  const form = project.slice(project.indexOf('Nome da produção'))
  assert.ok(form.indexOf('id="project-briefing"') < form.indexOf('O que este vídeo precisa provocar?'), 'the briefing comes before the objective')
  assert.ok(form.indexOf('id="project-briefing"') < form.indexOf('desired-action-fields'), 'and before the call to action')
  assert.ok(project.indexOf('<BriefingGuidance id="project-briefing-guidance"') > project.indexOf('<aside'), 'the guidance sits in the side column')
  const batch = source('src/app/batches/page.tsx')
  const composer = batch.slice(batch.indexOf('Planejar novo lote'))
  assert.ok(composer.indexOf('id="batch-briefing"') < composer.indexOf('Materiais autorizados'), 'the batch briefing comes before the materials')
  assert.ok(composer.indexOf('<BriefingGuidance') > composer.indexOf('<aside'), 'the guidance sits in the side column')
})

test('a closed question is shown as radio choices (accessible), an open one as a labelled text field, and an answer needs an output to be sent', () => {
  const panel = source('src/components/EditorialRequestPanel.tsx') + source('src/components/EditorialQuestionsForm.tsx')
  assert.match(panel, /<fieldset[^>]*data-testid=\{`question-choices-\$\{question\.id\}`\}/)
  assert.match(panel, /<legend/)
  assert.match(panel, /type="radio"/)
  assert.match(panel, /role="radiogroup"/)
  assert.match(panel, /htmlFor=\{`answer-\$\{question\.id\}`\}/)
  assert.match(panel, /answersNeedOutput/)
})

test('a project with no output says why its questions cannot be answered yet, with the published reason', () => {
  const refused = describeRequestFailure(428, { error: { code: 'PRECONDITION_REQUIRED', details: { reason: 'editorial-request-needs-output' } } })
  assert.match(refused.message, /ainda não tem um vídeo e uma saída/)
  assert.match(refused.message, /já está salvo/)
})

test('ADR-160: no question, choice or unsupported item the Apollo writes carries a code of its vocabulary or a sentence in English', () => {
  const kinds = Object.keys(DIRECTIVE_KIND_LABELS)
  for (const kind of Object.keys(EDITORIAL_DIRECTIVE_VOCABULARY)) assert.ok(kinds.includes(kind), `the catalog has no words for the kind ${kind}`)
  for (const [kind, entry] of Object.entries(EDITORIAL_DIRECTIVE_VOCABULARY)) {
    // The words of these come from the request itself (a subject, a language, the words of the call): the catalog gives them a frame, not a table.
    if (['keep', 'avoid', 'caption-language', 'cta-text', 'remove-speech'].includes(kind)) continue
    for (const value of entry.values) {
      const text = kind === 'caption-style' ? CAPTION_STYLE_LABELS[value] : DIRECTIVE_VALUE_LABELS[kind]?.[value]
      assert.ok(text, `the catalog has no words for ${kind} ${value}`)
      assert.doesNotMatch(text, /[a-z]+-[a-z]+/u, `a code leaks into the words of ${kind} ${value}: ${text}`)
      // What the Apollo does not execute yet says so; what it executes does not claim otherwise.
      const executable = EDITORIAL_EXECUTABLE_VALUES[kind].includes(value)
      if (kind !== 'caption-style') assert.equal(/ainda não/u.test(text), !executable, `${kind} ${value}: ${text}`)
    }
  }
  assert.equal(DIRECTIVE_VALUE_LABELS.movement['zoom-in'], 'Zoom (o Apollo ainda não aplica zoom)')
  assert.equal(DIRECTIVE_VALUE_LABELS.layout['fit-with-backdrop'], 'Encaixar a imagem inteira com fundo')
  assert.equal(DIRECTIVE_VALUE_LABELS.layout['source-native'], 'Manter o enquadramento da gravação')
  for (const sentence of [
    ambiguousDirectiveQuestion('layout', ['Manter o enquadramento da gravação', 'Encaixar a imagem inteira com fundo']),
    keepAndAvoidQuestion('tema do pedido'), outsideVocabularySummary('movement'), outsideVocabularySummary('unknown-kind'), notExecutableSummary('movement', 'zoom-in'),
  ]) {
    assert.doesNotMatch(sentence, /\b(?:layout|movement|source-native|fit-with-backdrop|zoom-in|vocabulary|Which|briefing asks)\b/u, sentence)
    assert.match(sentence, /[áàãâéêíóôõúç]|o Apollo|O briefing/u, sentence)
  }
  assert.equal(notExecutableSummary('movement', 'zoom-in'), 'Movimento de câmera: Zoom (o Apollo ainda não aplica zoom)')
})

test('the jargon the review named stays out of the project screen (the full sweep of every screen of the request is tests/v2/screen-language.test.mjs)', () => {
  const project = source('src/app/ProjectsPageClient.tsx')
  for (const jargon of ['Versão inicial imutável e auditável', 'entram na versão 1']) assert.equal(project.includes(jargon), false, jargon)
})
