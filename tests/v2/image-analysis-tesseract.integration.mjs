import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { TesseractImageVisionProvider } from '../../src/v2/infrastructure/image/tesseract-image-vision-provider.ts'
import { SharpImageAnalysisProcessor } from '../../src/v2/infrastructure/media/sharp-image-analysis-processor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

test('T-FR-047 real Sharp + Tesseract eval covers no text, small text and multilingual OCR without mutating sources', { skip: !process.env.APOLLO_TESSERACT_PATH }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-image-analysis-'))
  const processor = new SharpImageAnalysisProcessor(
    join(root, 'work'),
    new TesseractImageVisionProvider({ binary: process.env.APOLLO_TESSERACT_PATH }),
  )
  const fixtures = [
    {
      id: 'no-text',
      svg: '<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#204080"/></svg>',
    },
    {
      id: 'small-text',
      svg: '<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#f8f4e8"/><text x="900" y="740" font-family="DejaVu Sans" font-size="22" fill="#777777">texto pequeno</text></svg>',
    },
    {
      id: 'multilingual',
      svg: '<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#f8f4e8"/><text x="80" y="220" font-family="DejaVu Sans" font-size="86" font-weight="bold" fill="#102030">OFERTA VÁLIDA HOJE</text><text x="80" y="430" font-family="DejaVu Sans" font-size="92" font-weight="bold" fill="#204080">WELCOME APOLLO</text></svg>',
    },
  ]
  try {
    const results = new Map()
    for (const fixture of fixtures) {
      const sourcePath = join(root, `${fixture.id}.png`)
      await sharp(Buffer.from(fixture.svg)).png().toFile(sourcePath)
      const sourceHash = await calculateFileSha256(sourcePath)
      const result = await processor.analyze({
        operationId: `image-ocr-${fixture.id}`,
        sourcePath,
      })
      assert.equal(result.width, 1200)
      assert.equal(result.height, 800)
      assert.equal(result.ocr.state, 'available')
      assert.deepEqual(result.ocr.producer, {
        provider: 'tesseract', model: 'por-eng', version: 'v5',
      })
      assert.equal(result.inferredTags.every((tag) =>
        tag.provenance.startsWith('tesseract:por-eng@v5:ocr:')), true)
      assert.ok(result.thumbnail.width <= 320 && result.thumbnail.height <= 320)
      assert.ok(result.preview.width <= 1200 && result.preview.height <= 800)
      assert.ok((await stat(result.thumbnail.path)).size > 0)
      assert.ok((await stat(result.preview.path)).size > 0)
      assert.equal(await calculateFileSha256(sourcePath), sourceHash)
      results.set(fixture.id, result)
    }

    assert.deepEqual(results.get('no-text').ocr.values, [])
    const small = results.get('small-text').ocr.values
    assert.equal(small.every((region) => region.box[2] * region.box[3] < 0.01), true)
    const multilingual = results.get('multilingual').ocr.values
    const text = multilingual.map((region) => region.text).join(' ').toLocaleLowerCase()
    assert.match(text, /oferta/)
    assert.match(text, /welcome/)
    assert.equal(multilingual.some((region) => region.language === 'pt-BR'), true)
    assert.equal(multilingual.some((region) => region.language === 'en'), true)
    assert.equal(results.get('multilingual').faces.state, 'unavailable')
    assert.equal(results.get('multilingual').objects.state, 'unavailable')
  } finally {
    await Promise.all(fixtures.map((fixture) =>
      processor.cleanup(`image-ocr-${fixture.id}`)))
    await rm(root, { recursive: true, force: true })
  }
})
