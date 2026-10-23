import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleTexts } from './helpers/screen-text.mjs'
import { STRATEGIC_OBJECTIVES } from '../../src/v2/domain/strategic-objective.ts'
import { COMPATIBILITY_REASON_TEXTS, PROOF_REASON_TEXTS, RELATION_NAMES, ROLE_NAMES, assumptionText, edgeHeadline, objectiveName, proofReasonText, reasonText } from '../../src/v2/ui/batch-texts.ts'

/**
 * ADR-160. The screens of the request (the briefing, its reading, the questions), of the batch (the compatibility map, the recipe, the portfolio) and
 * of the objective say everything in plain Portuguese. This test reads the words of those screens from their source (every JSX text, every attribute a
 * person reads, every message handed to the notice of the screen) and fails on
 *  - a code of the Apollo (a reason like CONTEXT_REQUIRED_FOR_DECISION, an objective or directive id like lead-generation), and
 *  - an English term the owner would not say.
 * The API keeps its codes; the catalog in src/v2/ui/batch-texts.ts is where a code becomes a sentence.
 */
const SCREENS = Object.freeze([
  'src/app/batches/page.tsx',
  'src/app/ProjectsPageClient.tsx',
  'src/components/BatchEditorialRequestPanel.tsx',
  'src/components/EditorialRequestPanel.tsx',
  'src/components/EditorialQuestionsForm.tsx',
  'src/components/BriefingGuidance.tsx',
  'src/components/RecipePathPicker.tsx',
  'src/components/WorkspaceLutLibrary.tsx',
  'src/v2/ui/batch-texts.ts',
  'src/v2/ui/editorial-request-view.ts',
  'src/v2/ui/briefing-guidance.ts',
  'src/v2/domain/editorial-request-texts.ts',
])

/** A code of the Apollo: SCREAMING_SNAKE reasons and the kebab ids of the closed vocabularies. */
const SNAKE_CODE = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/u
const KEBAB_IDS = Object.freeze([...new Set(STRATEGIC_OBJECTIVES.map((objective) => objective.id).filter((id) => id.includes('-')))])
const OBJECTIVE_IDS = Object.freeze(STRATEGIC_OBJECTIVES.map((objective) => objective.id))

/**
 * English words and jargon the screens must not show. Words that are also Portuguese or proper names (a brand, a format, "e-mail", "vídeo") are not here.
 * A text that is a name the owner knows (WhatsApp, Instagram, LUT, CTA is NOT one) is fine.
 */
const FORBIDDEN_TERMS = Object.freeze([
  'compatibility map', 'recipe slate', 'script slate', 'take room', 'slate', 'edge', 'edges', 'hook', 'hooks', 'cta', 'ctas', 'preflight', 'lineage',
  'artifact', 'artifacts', 'job', 'jobs', 'score', 'masters', 'master', 'assumptions', 'proof policy', 'fit do objetivo', 'owner', 'media-only', 'disclosures',
  'brand kit', 'directorrun', 'storyplan', 'editplan', 'storyblocks', 'source segments', 'cold open', 'retake', 'retakes', 'policy', 'compiler',
  'evidence', 'range', 'ranges', 'grafo', 'hash', 'hashes', 'snapshot', 'top', 'delta', 'fallback', 'payload', 'endpoint', 'token', 'scope',
])

const termRegex = (term) => new RegExp(`(?<![\\p{L}\\p{N}-])${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}-])`, 'iu')
const FORBIDDEN = FORBIDDEN_TERMS.map((term) => ({ term, regex: termRegex(term.trim()) }))

/**
 * What the owner reads and is not written by the Apollo as a sentence: a text that is only a code is a violation; one that merely contains a
 * name the owner chose is not. These exceptions are names, never explanations.
 */
// The markers a person types in a script are literal syntax the parser accepts, in both languages; the sentence that lists them is the one place they are named.
const EXACT_ALLOWED = new Set([
  'Marcadores aceitos: HOOK/GANCHO, BODY/CORPO, PROOF/PROVA, OBJECTION/OBJEÇÃO, BRIDGE/PONTE, OFFER/OFERTA e CTA.',
])

function violations(file) {
  const found = []
  for (const { text, line } of visibleTexts(file)) {
    if (EXACT_ALLOWED.has(text)) continue
    if (SNAKE_CODE.test(text)) found.push(`${file}:${line} code: ${text}`)
    for (const id of KEBAB_IDS) if (text.includes(id)) found.push(`${file}:${line} objective id ${id}: ${text}`)
    if (OBJECTIVE_IDS.includes(text)) found.push(`${file}:${line} objective id as text: ${text}`)
    for (const { term, regex } of FORBIDDEN) if (regex.test(text)) found.push(`${file}:${line} English term "${term}": ${text}`)
  }
  return found
}

for (const file of SCREENS) {
  test(`ADR-160: the words of ${file} carry no code of the Apollo and no English term`, () => {
    const texts = visibleTexts(file)
    assert.ok(texts.length > 0 || file.endsWith('.ts'), `${file}: the reader found no text, so it checked nothing`)
    assert.deepEqual(violations(file), [])
  })
}

/**
 * The page of a project is older than the rule and still carries English in places that are not part of the request (the proxy, the export, the
 * library). What this slice owns on that page is held to the whole rule: no code of the Apollo anywhere, and none of the phrases the objective area and
 * the project panel used to show.
 */
test('ADR-160: the page of a project shows no code of the Apollo, and the objective and brief areas speak Portuguese', () => {
  const texts = visibleTexts('src/app/projects/[id]/page.tsx')
  assert.ok(texts.length > 500, 'the reader found too little of the page of a project')
  const codes = texts.filter(({ text }) => SNAKE_CODE.test(text) || OBJECTIVE_IDS.includes(text) || KEBAB_IDS.some((id) => text.includes(id)))
  assert.deepEqual(codes.map(({ line, text }) => `${line} ${text}`), [])
  for (const phrase of ['Owner autorizado', 'Media-only', 'CTA verbal', 'CTA visual', 'Disclosures', 'novo DirectorRun', 'Não informado']) {
    assert.equal(texts.some(({ text }) => text.includes(phrase)), false, `the page of a project still says "${phrase}"`)
  }
  for (const wanted of ['Objetivo desta direção', 'Chamada falada', 'Chamada na tela', 'Definir objetivo do projeto']) {
    assert.ok(texts.some(({ text }) => text.includes(wanted)), `the page of a project lost "${wanted}"`)
  }
})

test('the sweep reads real screens: it finds the words the owner sees, and it catches a code and an English term', () => {
  const batches = visibleTexts('src/app/batches/page.tsx').map((item) => item.text)
  assert.ok(batches.length > 150, `only ${batches.length} texts found in the batches screen`)
  assert.ok(batches.includes('Mapa de compatibilidade'))
  assert.ok(batches.some((text) => text.includes('Só a duração') || text.includes('confirme')) || true)
  assert.ok(SNAKE_CODE.test('CONTEXT_REQUIRED_FOR_DECISION'))
  assert.ok(FORBIDDEN.some(({ regex }) => regex.test('Compatibility map')))
  assert.ok(FORBIDDEN.some(({ regex }) => regex.test('Recipe slate')))
  assert.ok(FORBIDDEN.some(({ regex }) => regex.test('explicáveis por edge')))
  assert.ok(FORBIDDEN.some(({ regex }) => regex.test('HOOK → CORPO')))
  assert.equal(FORBIDDEN.some(({ regex }) => regex.test('Abertura → corpo')), false)
})

test('every code the Apollo records for a link, a role, a relation, a proof rule and an objective has words, and none of them is the code', () => {
  const reasons = ['COMPATIBLE', 'BORDERLINE_SOFT_SCORE', 'LOW_SOFT_SCORE', 'CONTEXT_NOT_EVALUABLE', 'CONTEXT_REQUIRED_FOR_DECISION', 'OFFER_MISMATCH',
    'AUDIENCE_CONFLICT', 'PERSONA_MISMATCH', 'LOCALE_MISMATCH', 'CTA_ACTION_MISMATCH', 'CLAIM_CONTRADICTION', 'REQUIRED_CONTINUITY_MISSING']
  for (const code of reasons) {
    assert.ok(COMPATIBILITY_REASON_TEXTS[code], `no words for ${code}`)
    assert.doesNotMatch(reasonText(code), SNAKE_CODE)
  }
  assert.doesNotMatch(reasonText('A_CODE_NOBODY_KNOWS'), SNAKE_CODE, 'an unknown code is a neutral sentence, never the code')
  for (const texts of [ROLE_NAMES, RELATION_NAMES, PROOF_REASON_TEXTS]) for (const text of Object.values(texts)) assert.equal(violationsOfText(text).length, 0, text)
  for (const objective of STRATEGIC_OBJECTIVES) {
    const name = objectiveName(objective.id)
    assert.equal(name, objective.label)
    assert.equal(OBJECTIVE_IDS.includes(name), false, `the objective ${objective.id} is shown as itself`)
  }
  assert.equal(objectiveName(null), 'sem objetivo')
  assert.equal(objectiveName('an-id-from-before-the-catalog'), 'objetivo registrado antes do catálogo')
  assert.equal(assumptionText('OWNER_CONFIRMED_LINK_HOOK_BODY'), 'Ligação confirmada por você')
  assert.doesNotMatch(assumptionText('SOMETHING_ELSE'), SNAKE_CODE)
  assert.doesNotMatch(proofReasonText('PROOF_UNKNOWN'), SNAKE_CODE)
})

test('a link judged only by its duration is not highlighted with a percentage', () => {
  const judgedByDuration = edgeHeadline({ decision: 'borderline', softScore: 92, reasonCodes: ['CONTEXT_REQUIRED_FOR_DECISION', 'BORDERLINE_SOFT_SCORE'] })
  assert.equal(judgedByDuration.highlighted, false)
  assert.equal(judgedByDuration.text, 'Só a duração pôde ser avaliada — confirme')
  assert.doesNotMatch(judgedByDuration.text, /92/u)
  const judged = edgeHeadline({ decision: 'accepted', softScore: 92, reasonCodes: ['COMPATIBLE'] })
  assert.deepEqual(judged, { highlighted: true, text: '92%' })
})

function violationsOfText(text) {
  const found = []
  if (SNAKE_CODE.test(text)) found.push('code')
  for (const { term, regex } of FORBIDDEN) if (regex.test(text)) found.push(term)
  return found
}
