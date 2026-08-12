import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogImage, IMAGE_EVAL_FIXTURES, searchImages } from '../../src/v2/domain/image-library.ts'
import { createImageAnalysis } from '../../src/v2/domain/image-analysis.ts'
import { parseTesseractTsv } from '../../src/v2/infrastructure/image/tesseract-image-vision-provider.ts'

const analyze = (overrides = {}) => catalogImage({ assetId: 'img', width: 1080, height: 1350, colors: ['#102030'], faces: [{ label: 'especialista', confidence: .9 }], objects: [{ label: 'microfone', confidence: .88 }], ocrRegions: [], model: 'vision', modelVersion: '1.2', ...overrides })

test('T-FR-047 catalogs dimensions, orientation, colors, faces, objects and multilingual OCR with provenance', () => {
  const record = analyze({ ocrRegions: IMAGE_EVAL_FIXTURES[2].ocr })
  assert.equal(record.orientation, 'portrait')
  assert.match(record.observedDescription, /Welcome/)
  assert.equal(record.inferredTags.find((tag) => tag.value === 'welcome').provenance, 'vision@1.2:ocr:en')
  assert.equal(record.derivatives.every((value) => value.immutableOriginal), true)
})

test('T-FR-047 canonical image analysis separates observed coverage from inference and is tamper-evident', () => {
  const unavailable = (reason) => ({ state: 'unavailable', values: [], producer: { provider: 'not-configured', model: 'none', version: 'v1' }, reasonCodes: [reason] })
  const analysis = createImageAnalysis({ id: 'analysis-image-1', workspaceId: 'workspace-image-1', artifactId: 'artifact-image-1', manifestId: 'manifest-image-1', sourceSha256: 'a'.repeat(64), dimensions: { width: 1080, height: 1350 }, dominantColors: ['#102030'], ocr: { state: 'available', values: [{ text: 'Oferta válida hoje', language: 'pt-BR', box: [0.1, 0.8, 0.8, 0.08], confidence: 0.91, importance: 'high' }], producer: { provider: 'tesseract', model: 'por-eng', version: 'v5' }, reasonCodes: [] }, faces: unavailable('FACE_PROVIDER_NOT_CONFIGURED'), objects: unavailable('OBJECT_PROVIDER_NOT_CONFIGURED'), observedDescription: 'Imagem portrait 1080×1350 com texto observado.', inferredTags: [{ value: 'oferta', confidence: 0.91, provenance: 'tesseract:por-eng@v5:ocr:pt-BR' }], derivatives: { thumbnailArtifactId: 'artifact-thumb-1', previewArtifactId: 'artifact-preview-1', immutableOriginal: true }, createdAt: '2026-08-09T00:00:00.000Z' })
  assert.equal(analysis.orientation, 'portrait')
  assert.equal(analysis.faces.state, 'unavailable')
  assert.match(analysis.analysisHash, /^[a-f0-9]{64}$/)
  assert.throws(() => createImageAnalysis({ ...analysis, dominantColors: [], analysisHash: undefined }), /colors/i)
})

test('T-FR-047 Tesseract TSV keeps normalized regions, confidence, language and small-text importance', () => {
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t700\t800\t200\t50\t61.0\tOferta\n5\t1\t1\t1\t1\t2\t100\t200\t300\t100\t96.0\tWelcome\n'
  const regions = parseTesseractTsv(tsv, { width: 1000, height: 1000, language: 'eng' })
  assert.deepEqual(regions.map((region) => region.language), ['en', 'en'])
  assert.equal(regions[0].importance, 'low')
  assert.equal(regions[1].importance, 'high')
  assert.deepEqual(regions[0].box, [0.7, 0.8, 0.2, 0.05])
})

test('T-FR-047 searches reusable images for b-roll, insert and card and covers visual eval fixtures', () => {
  const noText = analyze({ assetId: 'none', objects: [], faces: [], ocrRegions: [] })
  const small = analyze({ assetId: 'small', ocrRegions: IMAGE_EVAL_FIXTURES[1].ocr })
  assert.match(noText.observedDescription, /sem objetos ou texto/)
  for (const usage of ['b-roll', 'insert', 'card']) assert.equal(searchImages([noText, small], { text: 'oferta', usage })[0].usage, usage)
  assert.equal(IMAGE_EVAL_FIXTURES.length, 3)
})
