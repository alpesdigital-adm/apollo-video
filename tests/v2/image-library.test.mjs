import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogImage, IMAGE_EVAL_FIXTURES, rankReusableImages, searchImages } from '../../src/v2/domain/image-library.ts'
import { createImageAnalysis } from '../../src/v2/domain/image-analysis.ts'
import { parseTesseractTsv } from '../../src/v2/infrastructure/image/tesseract-image-vision-provider.ts'
import { reuseImageArtifactService, searchReusableImagesService } from '../../src/v2/application/analyze-image-artifact.ts'

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

const reusable = (id, { objects = [], faces = [], ocr = [], tags = [] } = {}) => ({
  analysis: createImageAnalysis({
    id: `analysis-${id}`, workspaceId: 'workspace-image-1', artifactId: `artifact-${id}`, manifestId: `manifest-${id}`,
    sourceSha256: id.padEnd(64, id[0]).slice(0, 64).replace(/[^a-f0-9]/g, 'a'), dimensions: { width: 1080, height: 1350 }, dominantColors: ['#102030'],
    ocr: { state: 'available', values: ocr, producer: { provider: 'tesseract', model: 'por-eng', version: 'v5' }, reasonCodes: [] },
    faces: { state: 'available', values: faces, producer: { provider: 'vision', model: 'detector', version: 'v1' }, reasonCodes: [] },
    objects: { state: 'available', values: objects, producer: { provider: 'vision', model: 'detector', version: 'v1' }, reasonCodes: [] },
    observedDescription: `Imagem ${id} com produto premium`, inferredTags: tags,
    derivatives: { thumbnailArtifactId: `thumb-${id}`, previewArtifactId: `preview-${id}`, immutableOriginal: true }, createdAt: '2026-08-12T00:00:00.000Z',
  }),
  label: `Imagem ${id}`, rightsSnapshotId: `rights-${id}`, rightsSnapshotHash: 'b'.repeat(64), rightsValidUntil: '2026-08-12T00:05:00.000Z',
})

test('T-FR-047 purpose-preserving ranking favors visual b-roll and text-bearing cards deterministically', () => {
  const product = reusable('product', { objects: [{ label: 'produto', box: [0.1, 0.1, 0.5, 0.5], confidence: 0.95 }], tags: [{ value: 'premium', confidence: 0.9, provenance: 'vision@v1:object' }] })
  const offer = reusable('offer', { ocr: [{ text: 'Oferta premium', language: 'pt-BR', box: [0.1, 0.2, 0.8, 0.4], confidence: 0.97, importance: 'high' }], tags: [{ value: 'premium', confidence: 0.97, provenance: 'tesseract@v5:ocr:pt-BR' }] })
  assert.equal(rankReusableImages({ workspaceId: 'workspace-image-1', text: 'produto premium', usage: 'b-roll' }, [offer, product])[0].artifactId, 'artifact-product')
  assert.equal(rankReusableImages({ workspaceId: 'workspace-image-1', text: 'produto premium', usage: 'card' }, [product, offer])[0].artifactId, 'artifact-offer')
  assert.equal(rankReusableImages({ workspaceId: 'workspace-image-1', text: 'produto premium', usage: 'insert' }, [product, offer])[0].usage, 'insert')
  assert.deepEqual(rankReusableImages({ workspaceId: 'workspace-image-1', text: 'inexistente', usage: 'card' }, [product]), [])
  assert.throws(() => rankReusableImages({ workspaceId: 'other-workspace', text: 'produto', usage: 'card' }, [product]), /workspace/i)
})

test('T-FR-047 application journey preserves purpose then persists reference-only lineage', async () => {
  const calls = []
  const candidate = rankReusableImages({ workspaceId: 'workspace-image-1', text: 'produto premium', usage: 'insert' }, [reusable('product', { objects: [{ label: 'produto', box: [0.1, 0.1, 0.5, 0.5], confidence: 0.95 }] })])[0]
  const repository = {
    async searchReusable(query, now) { calls.push(['search', query, now.toISOString()]); return [candidate] },
    async reuse(input) { calls.push(['reuse', input]); return { schemaVersion: 'image-reuse-reference/v1', id: 'image-reuse-1', ...input, manifestId: candidate.manifestId, mediaAssetReferenceId: 'media-asset-1', analysisId: candidate.analysisId, analysisHash: candidate.analysisHash, rightsSnapshotId: candidate.rightsSnapshotId, rightsSnapshotHash: candidate.rightsSnapshotHash, score: candidate.score, bytesDuplicated: false, lineageHash: 'd'.repeat(64), replayed: false } },
  }
  const clock = () => new Date('2026-08-12T12:00:00.000Z')
  const search = await searchReusableImagesService({ repository, clock })({ workspaceId: 'workspace-image-1', text: ' Produto premium ', usage: 'insert', limit: 3 })
  assert.equal(search.usage, 'insert')
  assert.equal(search.items[0].usage, 'insert')
  const reuse = await reuseImageArtifactService({ repository, clock })({ workspaceId: 'workspace-image-1', projectId: 'project-image-1', artifactId: candidate.artifactId, usage: 'insert', text: 'Produto premium' })
  assert.equal(reuse.bytesDuplicated, false)
  assert.equal(calls[1][1].usage, 'insert')
  assert.equal(calls[1][1].text, 'produto premium')
})
