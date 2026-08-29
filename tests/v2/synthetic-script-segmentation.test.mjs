import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SYNTHETIC_SCRIPT_SEGMENTATION_VERSION,
  segmentSyntheticScript,
} from '../../src/v2/domain/synthetic-script-segmentation.ts'

const constraints = { minCharacters: 1, maxCharacters: 1000 }
const texts = (blocks) => blocks.map(({ exactText }) => exactText)

test('T-FR-102 segments complete sentences and keeps punctuation', () => {
  const blocks = segmentSyntheticScript({ text: 'Primeira frase. Segunda frase! Terceira?', constraints })
  assert.deepEqual(texts(blocks), ['Primeira frase.', 'Segunda frase!', 'Terceira?'])
  assert.equal(SYNTHETIC_SCRIPT_SEGMENTATION_VERSION, 'synthetic-script-segmentation/v1')
})

test('T-FR-102 abbreviations and initials never end a sentence', () => {
  const blocks = segmentSyntheticScript({
    text: 'O Dr. Silva atendeu a Sra. Souza hoje. O Prof. J. Almeida confirmou, etc. e seguiu. Fim.',
    constraints,
  })
  assert.deepEqual(texts(blocks), [
    'O Dr. Silva atendeu a Sra. Souza hoje.',
    'O Prof. J. Almeida confirmou, etc. e seguiu.',
    'Fim.',
  ])
})

test('T-FR-102 decimals, currency and dates stay inside their sentence', () => {
  const blocks = segmentSyntheticScript({
    text: 'O CPL fechou em R$ 15,90 na terça. A meta era 3.14 pontos em 31.01.2026. Sem pontuação final',
    constraints,
  })
  assert.deepEqual(texts(blocks), [
    'O CPL fechou em R$ 15,90 na terça.',
    'A meta era 3.14 pontos em 31.01.2026.',
    'Sem pontuação final',
  ])
})

test('T-FR-102 quotes and parentheses protect their interior punctuation', () => {
  const blocks = segmentSyntheticScript({
    text: 'Ele disse: "Vai lá! Agora." E foi. (Nada mudou. Nada.) Fim.',
    constraints,
  })
  assert.deepEqual(texts(blocks), [
    'Ele disse: "Vai lá! Agora." E foi.',
    '(Nada mudou. Nada.) Fim.',
  ])
})

test('T-FR-102 ellipses end a reflection only before a visible new start', () => {
  const blocks = segmentSyntheticScript({
    text: 'Pensei muito... e decidi. Foi difícil… Mas valeu!',
    constraints,
  })
  assert.deepEqual(texts(blocks), ['Pensei muito... e decidi.', 'Foi difícil…', 'Mas valeu!'])
})

test('T-FR-102 deliberate line breaks are hard boundaries', () => {
  const blocks = segmentSyntheticScript({ text: 'Linha um sem ponto\nLinha dois. Ainda linha dois.', constraints })
  assert.deepEqual(texts(blocks), ['Linha um sem ponto', 'Linha dois.', 'Ainda linha dois.'])
})

test('T-FR-102 diacritics and emojis survive segmentation byte-exact', () => {
  const blocks = segmentSyntheticScript({ text: 'A decisão é sua 🚀. Não erre: ação, coração!', constraints })
  assert.deepEqual(texts(blocks), ['A decisão é sua 🚀.', 'Não erre: ação, coração!'])
})

test('T-FR-102 short texts produce a single block', () => {
  assert.deepEqual(texts(segmentSyntheticScript({ text: 'Oi', constraints })), ['Oi'])
})

test('T-FR-102 identical sentences stay distinct ordered occurrences', () => {
  const blocks = segmentSyntheticScript({
    text: 'Gastou e não converteu. Gastou e não converteu.',
    constraints,
  })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].normalizedTextHash, blocks[1].normalizedTextHash)
  assert.deepEqual(blocks.map(({ occurrence }) => occurrence), [1, 2])
})

test('T-FR-102 sentences below the minimum merge with a neighbour in the same line', () => {
  const blocks = segmentSyntheticScript({
    text: 'Sim. Claro. Uma frase bem maior do que todas as outras aqui.',
    constraints: { minCharacters: 8, maxCharacters: 1000 },
  })
  assert.deepEqual(texts(blocks), ['Sim. Claro.', 'Uma frase bem maior do que todas as outras aqui.'])
})

test('T-FR-102 oversized sentences split at safe boundaries, never inside a word', () => {
  const text = 'Esta frase é bem longa, cheia de vírgulas, e precisa ser dividida com muita segurança agora'
  const blocks = segmentSyntheticScript({ text, constraints: { minCharacters: 1, maxCharacters: 40 } })
  assert.ok(blocks.length >= 2)
  for (const block of blocks) {
    assert.ok(block.exactText.length <= 40, `block too long: ${block.exactText}`)
  }
  const words = (value) => value.split(/\s+/).filter(Boolean)
  assert.deepEqual(blocks.flatMap((block) => words(block.exactText)).join(' '), words(text).join(' '))
})

test('T-FR-102 an unbreakable overlong word fails closed', () => {
  assert.throws(
    () => segmentSyntheticScript({ text: 'x'.repeat(50), constraints: { minCharacters: 1, maxCharacters: 30 } }),
    (error) => error.code === 'INVALID_ARGUMENT' && /safe split/.test(error.message),
  )
})

test('T-FR-102 segmentation is deterministic', () => {
  const text = 'Primeira. Segunda! "Terceira?" (Quarta.) Quinta sem ponto'
  assert.deepEqual(
    segmentSyntheticScript({ text, constraints }),
    segmentSyntheticScript({ text, constraints }),
  )
})

test('T-FR-102 control characters are rejected fail-closed', () => {
  assert.throws(
    () => segmentSyntheticScript({ text: `a${String.fromCharCode(0)}b`, constraints }),
    (error) => error.code === 'INVALID_ARGUMENT' && /control characters/.test(error.message),
  )
  assert.throws(
    () => segmentSyntheticScript({ text: '   ', constraints }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})
