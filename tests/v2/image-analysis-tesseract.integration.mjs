import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { TesseractImageVisionProvider } from '../../src/v2/infrastructure/image/tesseract-image-vision-provider.ts'
import { SharpImageAnalysisProcessor } from '../../src/v2/infrastructure/media/sharp-image-analysis-processor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

test('T-FR-047 real Sharp + Tesseract extracts multilingual OCR and immutable derivatives', { skip: !process.env.APOLLO_TESSERACT_PATH }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-image-analysis-')); const sourcePath = join(root, 'multilingual.png')
  const svg = `<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#f8f4e8"/><text x="80" y="220" font-family="DejaVu Sans" font-size="86" font-weight="bold" fill="#102030">OFERTA VÁLIDA HOJE</text><text x="80" y="430" font-family="DejaVu Sans" font-size="92" font-weight="bold" fill="#204080">WELCOME APOLLO</text><text x="820" y="730" font-family="DejaVu Sans" font-size="22" fill="#202020">texto pequeno</text></svg>`
  await sharp(Buffer.from(svg)).png().toFile(sourcePath); const sourceHash = await calculateFileSha256(sourcePath)
  const processor = new SharpImageAnalysisProcessor(join(root, 'work'), new TesseractImageVisionProvider({ binary: process.env.APOLLO_TESSERACT_PATH }))
  try {
    const result = await processor.analyze({ operationId: 'image-ocr-real', sourcePath })
    assert.equal(result.width, 1200); assert.equal(result.height, 800); assert.equal(result.ocr.state, 'available')
    const text = result.ocr.values.map((region) => region.text).join(' ').toLocaleLowerCase()
    assert.match(text, /oferta/); assert.match(text, /welcome/)
    assert.deepEqual(result.ocr.producer, { provider: 'tesseract', model: 'por-eng', version: 'v5' })
    assert.equal(result.faces.state, 'unavailable'); assert.equal(result.objects.state, 'unavailable')
    assert.ok(result.thumbnail.width <= 320 && result.thumbnail.height <= 320); assert.ok(result.preview.width <= 1200 && result.preview.height <= 800)
    assert.ok((await stat(result.thumbnail.path)).size > 0); assert.ok((await stat(result.preview.path)).size > 0)
    assert.equal(await calculateFileSha256(sourcePath), sourceHash)
  } finally { await processor.cleanup('image-ocr-real'); await rm(root, { recursive: true, force: true }) }
})
