import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogImage, IMAGE_EVAL_FIXTURES, searchImages } from '../../src/v2/domain/image-library.ts'

const analyze = (overrides = {}) => catalogImage({ assetId: 'img', width: 1080, height: 1350, colors: ['#102030'], faces: [{ label: 'especialista', confidence: .9 }], objects: [{ label: 'microfone', confidence: .88 }], ocrRegions: [], model: 'vision', modelVersion: '1.2', ...overrides })

test('T-FR-047 catalogs dimensions, orientation, colors, faces, objects and multilingual OCR with provenance', () => {
  const record = analyze({ ocrRegions: IMAGE_EVAL_FIXTURES[2].ocr })
  assert.equal(record.orientation, 'portrait')
  assert.match(record.observedDescription, /Welcome/)
  assert.equal(record.inferredTags.find((tag) => tag.value === 'welcome').provenance, 'vision@1.2:ocr:en')
  assert.equal(record.derivatives.every((value) => value.immutableOriginal), true)
})

test('T-FR-047 searches reusable images for b-roll, insert and card and covers visual eval fixtures', () => {
  const noText = analyze({ assetId: 'none', objects: [], faces: [], ocrRegions: [] })
  const small = analyze({ assetId: 'small', ocrRegions: IMAGE_EVAL_FIXTURES[1].ocr })
  assert.match(noText.observedDescription, /sem objetos ou texto/)
  for (const usage of ['b-roll', 'insert', 'card']) assert.equal(searchImages([noText, small], { text: 'oferta', usage })[0].usage, usage)
  assert.equal(IMAGE_EVAL_FIXTURES.length, 3)
})
