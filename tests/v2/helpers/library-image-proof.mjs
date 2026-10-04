import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

import { analyzeImageArtifactService } from '../../../src/v2/application/analyze-image-artifact.ts'
import { setAssetRightsService } from '../../../src/v2/application/set-asset-rights.ts'
import { createMediaArtifactManifest } from '../../../src/v2/domain/media-artifact.ts'
import { PrismaAssetRightsRepository } from '../../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { PrismaImageAnalysisRepository } from '../../../src/v2/infrastructure/prisma/image-analysis-repository.ts'
import { PrismaMediaArtifactRepository } from '../../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
import { LocalMediaUploadStorage } from '../../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { calculateFileSha256 } from '../../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { SharpImageAnalysisProcessor } from '../../../src/v2/infrastructure/media/sharp-image-analysis-processor.ts'
import { TesseractImageVisionProvider } from '../../../src/v2/infrastructure/image/tesseract-image-vision-provider.ts'

const FIXTURES = Object.freeze({
  plain: '<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#204080"/></svg>',
  small: '<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#f8f4e8"/><text x="900" y="740" font-family="DejaVu Sans" font-size="22" fill="#777777">texto pequeno</text></svg>',
  multilingual: '<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#f8f4e8"/><text x="80" y="220" font-family="DejaVu Sans" font-size="86" font-weight="bold" fill="#102030">OFERTA VALIDA HOJE</text><text x="80" y="430" font-family="DejaVu Sans" font-size="92" font-weight="bold" fill="#204080">WELCOME APOLLO</text></svg>',
})

// W50 can upload the exact same controlled PNG bytes through HTTP, then let
// its own server/worker create the artifact IDs in the shared artifact root.
export async function createImageFixtureBytes(fixture = 'plain') {
  if (!Object.hasOwn(FIXTURES, fixture)) throw new Error(`Unknown image fixture ${fixture}`)
  return sharp(Buffer.from(FIXTURES[fixture])).png().toBuffer()
}

// Owns only rows and files bearing its random workspace ID. Importing this
// helper has no side effects; the caller owns the Prisma connection and server.
export async function seedAnalyzedImageLibrary({ prisma, fixture = 'plain', tesseractPath, workspaceId = `image-proof-${randomUUID().slice(0, 8)}` }) {
  if (!Object.hasOwn(FIXTURES, fixture)) throw new Error(`Unknown image fixture ${fixture}`)
  const root = await mkdtemp(join(tmpdir(), 'apollo-image-library-proof-'))
  const storage = new LocalMediaUploadStorage(join(root, 'storage'))
  const artifacts = new PrismaMediaArtifactRepository(prisma)
  const analyses = new PrismaImageAnalysisRepository(prisma)
  const projectId = `${workspaceId}-project`
  const artifactId = `${workspaceId}-source`
  const manifestId = `${workspaceId}-manifest`
  const operationId = `${workspaceId}-analysis`
  const sourcePath = join(root, `${fixture}.png`)
  let created = false
  const cleanup = async () => {
    if (created) {
      await prisma.v2ImageReuseReference.deleteMany({ where: { workspaceId } })
      await prisma.v2ImageAnalysis.deleteMany({ where: { workspaceId } })
      await prisma.v2MediaLibraryEntry.deleteMany({ where: { workspaceId } })
      await prisma.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
      await prisma.v2MediaArtifact.updateMany({ where: { workspaceId }, data: { currentRightsSnapshotId: null } })
      await prisma.v2AssetRightsChange.deleteMany({ where: { workspaceId } })
      await prisma.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId } })
      await prisma.v2MediaArtifactLineage.deleteMany({ where: { workspaceId } })
      await prisma.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
      await prisma.v2MediaArtifact.deleteMany({ where: { workspaceId } })
      await prisma.v2Project.deleteMany({ where: { workspaceId } })
      await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
    }
    await rm(root, { recursive: true, force: true })
  }
  try {
    await prisma.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Image proof' } })
    created = true
    await prisma.v2Project.create({ data: { id: projectId, workspaceId, name: 'Image proof', locale: 'pt-BR', createdByType: 'user', createdById: 'image-proof' } })
    await writeFile(sourcePath, await createImageFixtureBytes(fixture))
    const sourceBytes = await readFile(sourcePath)
    const sourceSha256 = await calculateFileSha256(sourcePath)
    const master = await storage.promoteDerived({ workspaceId, sourcePath, sha256: sourceSha256, extension: 'png', prefix: 'masters' })
    const manifest = createMediaArtifactManifest({ artifactKey: master.key, artifactSha256: sourceSha256, byteSize: sourceBytes.length, mediaType: 'image', container: 'png', recipe: { id: 'direct-upload', version: '1.0.0', parameters: { mimeType: 'image/png' } } })
    await artifacts.persistOrReplay({ workspaceId, artifactId, manifestId, lineageIds: [], manifest, createdAt: new Date().toISOString() })
    const rights = new PrismaAssetRightsRepository(prisma)
    const current = await rights.findCurrent(workspaceId, artifactId)
    await setAssetRightsService({ repository: rights, clock: () => new Date(), createId: () => `${workspaceId}-rights` })({
      workspaceId, artifactId, baseRevision: current.revision,
      actor: { type: 'user', id: 'image-proof' },
      draft: { status: 'approved', allowedUses: ['editorial-reuse', 'rendering'], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] } },
    })
    await prisma.v2MediaLibraryEntry.create({ data: { artifactId, workspaceId, label: `${fixture}.png`, peopleJson: '[]', peopleSearch: '\n', topicsJson: '[]', topicsSearch: '\n', originType: 'upload' } })
    const processor = new SharpImageAnalysisProcessor(join(root, 'work'), tesseractPath ? new TesseractImageVisionProvider({ binary: tesseractPath }) : undefined)
    const analyze = analyzeImageArtifactService({ processor, repository: analyses, artifacts, storage, integrity: { sha256: calculateFileSha256 } })
    const analyzeAgain = () => analyze({ operationId, workspaceId, artifactId, manifestId, artifactKey: master.key, sourcePath: master.path, sourceSha256 })
    const result = await analyzeAgain()
    return Object.freeze({ workspaceId, projectId, artifactId, manifestId, root, storage, sourcePath, sourceBytes, sourceSha256, master, analysis: result.analysis, replayed: result.replayed, analyzeAgain, prisma, cleanup })
  } catch (error) {
    await cleanup()
    throw error
  }
}
