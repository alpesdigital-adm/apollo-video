import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { PrismaMediaLibraryRepository } from '../../src/v2/infrastructure/prisma/media-library-repository.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { seedAnalyzedImageLibrary } from './helpers/library-image-proof.mjs'

test('W48 real bytes, storage and PostgreSQL expose immutable image analysis and thumbnail', { skip: !process.env.V2_DATABASE_URL }, async () => {
  const prisma = new PrismaClient()
  const seeded = []
  try {
    for (const fixture of ['plain', 'small', 'multilingual']) seeded.push(await seedAnalyzedImageLibrary({ prisma, fixture, tesseractPath: process.env.APOLLO_TESSERACT_PATH }))
    for (const entry of seeded) {
    const { workspaceId, artifactId, sourceSha256, sourcePath, sourceBytes, analysis, storage } = entry
    const row = await prisma.v2ImageAnalysis.findFirstOrThrow({ where: { workspaceId, artifactId } })
    assert.equal(row.analysisHash, analysis.analysisHash)
    assert.equal(row.sourceSha256, sourceSha256)
    assert.deepEqual(analysis.dimensions, { width: 1200, height: 800 })
    assert.equal(analysis.orientation, 'landscape')
    assert.equal(analysis.faces.state, 'unavailable')
    assert.equal(analysis.objects.state, 'unavailable')
    if (process.env.APOLLO_TESSERACT_PATH) {
      assert.equal(analysis.ocr.state, 'available')
      if (entry.sourcePath.endsWith('plain.png')) assert.deepEqual(analysis.ocr.values, [])
      if (entry.sourcePath.endsWith('multilingual.png')) {
        const observed = analysis.ocr.values.map((region) => region.text).join(' ').toLowerCase()
        assert.match(observed, /oferta/)
        assert.match(observed, /welcome/)
        assert.equal(analysis.inferredTags.every((tag) => analysis.ocr.values.some((region) => tag.provenance.includes(region.language))), true)
      }
    } else {
      assert.equal(analysis.ocr.state, 'unavailable')
    }
    const libraryEntry = await prisma.v2MediaLibraryEntry.findUniqueOrThrow({ where: { artifactId } })
    assert.equal(libraryEntry.thumbnailArtifactId, analysis.derivatives.thumbnailArtifactId)
    const library = await new PrismaMediaLibraryRepository(prisma).list({ workspaceId, limit: 10 }, new Date())
    const item = library.items.find((value) => value.id === artifactId)
    assert.equal(item?.preview.thumbnail.artifactId, analysis.derivatives.thumbnailArtifactId)
    assert.equal(item?.rights.status, 'eligible')
    const derivatives = await Promise.all([analysis.derivatives.thumbnailArtifactId, analysis.derivatives.previewArtifactId].map((id) => prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id } })))
    for (const derivative of derivatives) {
      const path = join(storage.root, ...derivative.artifactKey.split('/'))
      const bytes = await readFile(path)
      assert.equal(await calculateFileSha256(path), derivative.sha256)
      assert.notDeepEqual(bytes, sourceBytes)
      const metadata = await sharp(bytes).metadata()
      assert.ok(metadata.width <= 1280 && metadata.height <= 1280)
    }
    assert.equal(await calculateFileSha256(sourcePath), sourceSha256)
    assert.equal((await entry.analyzeAgain()).replayed, true)
    assert.equal(await prisma.v2ImageAnalysis.count({ where: { workspaceId, artifactId } }), 1)
    assert.equal(await prisma.v2ImageAnalysis.count({ where: { workspaceId: 'other-workspace', artifactId } }), 0)
    }
    assert.equal(new Set(seeded.map((entry) => entry.workspaceId)).size, 3)
  } finally {
    for (const entry of seeded.reverse()) await entry.cleanup()
    await prisma.$disconnect()
  }
})
