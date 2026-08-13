import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { attachMediaLibraryItemService } from '../../src/v2/application/media-library.ts'
import { createMediaSegmentService } from '../../src/v2/application/media-segments.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { mediaLibrarySearchField } from '../../src/v2/domain/media-library.ts'
import { PrismaMediaLibraryRepository } from '../../src/v2/infrastructure/prisma/media-library-repository.ts'
import { PrismaImageAnalysisRepository } from '../../src/v2/infrastructure/prisma/image-analysis-repository.ts'
import { createImageAnalysis } from '../../src/v2/domain/image-analysis.ts'
import { PrismaMediaSegmentRepository } from '../../src/v2/infrastructure/prisma/media-segment-repository.ts'

function rightsRow(snapshot) {
  return {
    id: snapshot.id, workspaceId: snapshot.workspaceId, artifactId: snapshot.artifactId, sequence: snapshot.sequence,
    schemaVersion: snapshot.schemaVersion, snapshotHash: snapshot.snapshotHash, status: snapshot.status,
    allowedUsesJson: stableSerialize(snapshot.allowedUses), prohibitedUsesJson: stableSerialize(snapshot.prohibitedUses),
    allowedWorkspaceIdsJson: stableSerialize(snapshot.allowedWorkspaceIds), consentStatus: snapshot.consent.status,
    consentAllowedUsesJson: stableSerialize(snapshot.consent.allowedUses), createdByType: snapshot.createdBy.type,
    createdById: snapshot.createdBy.id, createdAt: new Date(snapshot.createdAt),
  }
}

test('T-FR-040 Prisma library keeps cursor/filter isolation and attaches one rights-cleared reference without byte copy', { skip: !process.env.V2_DATABASE_URL }, async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `library-${suffix}`
  const otherWorkspaceId = `library-other-${suffix}`
  const projectId = `library-project-${suffix}`
  const repository = new PrismaMediaLibraryRepository(prisma)
  const imageRepository = new PrismaImageAnalysisRepository(prisma)
  const segmentRepository = new PrismaMediaSegmentRepository(prisma)
  const artifactIds = ['video', 'audio', 'restricted', 'other'].map((kind) => `library-${kind}-${suffix}`)
  const thumbnailId = `library-thumbnail-${suffix}`
  const cleanup = async () => {
    await prisma.v2ImageReuseReference.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2ImageAnalysis.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2MediaSegmentMaterialization.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2MediaSegment.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2ProjectMediaAsset.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2MediaArtifact.updateMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } }, data: { currentRightsSnapshotId: null } })
    await prisma.v2MediaLibraryEntry.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2MediaArtifact.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2Project.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2Workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
  }
  try {
    await cleanup()
    await prisma.v2Workspace.createMany({ data: [
      { id: workspaceId, slug: workspaceId, name: 'Library integration' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other library' },
    ] })
    await prisma.v2Project.create({ data: {
      id: projectId, workspaceId, name: 'Target project', locale: 'pt-BR', createdByType: 'user', createdById: 'integration-test',
    } })
    const artifacts = [
      { id: artifactIds[0], workspaceId, mediaType: 'video', container: 'mp4', status: 'available', byteSize: 1111n },
      { id: artifactIds[1], workspaceId, mediaType: 'audio', container: 'wav', status: 'available', byteSize: 2222n },
      { id: artifactIds[2], workspaceId, mediaType: 'image', container: 'png', status: 'available', byteSize: 3333n },
      { id: artifactIds[3], workspaceId: otherWorkspaceId, mediaType: 'video', container: 'mp4', status: 'available', byteSize: 4444n },
    ]
    for (const [index, artifact] of artifacts.entries()) await prisma.v2MediaArtifact.create({ data: {
      ...artifact, artifactKey: `${artifact.workspaceId}/${artifact.id}`, sha256: String(index + 1).repeat(64),
      createdAt: new Date(`2026-08-08T12:0${index}:00.000Z`),
    } })
    await prisma.v2MediaArtifact.create({ data: {
      id: thumbnailId, workspaceId, mediaType: 'image', container: 'jpeg', status: 'available', byteSize: 555n,
      artifactKey: `${workspaceId}/${thumbnailId}`, sha256: '5'.repeat(64), createdAt: new Date('2026-08-08T11:59:00.000Z'),
    } })
    await prisma.v2MediaArtifactManifest.create({ data: { id: `manifest-${artifactIds[0]}`, workspaceId, artifactId: artifactIds[0], schemaVersion: 'media-artifact-manifest/v1', manifestHash: 'e'.repeat(64), recipeId: 'upload', recipeVersion: '1.0.0', parametersHash: 'f'.repeat(64), manifestJson: stableSerialize({ schemaVersion: 'media-artifact-manifest/v1', artifact: { artifactKey: `${workspaceId}/${artifactIds[0]}`, sha256: '1'.repeat(64), byteSize: 1111, mediaType: 'video', container: 'mp4' }, recipe: { id: 'upload', version: '1.0.0', parametersHash: 'f'.repeat(64) }, sources: [], probe: { width: 540, height: 960, duration: 10, fps: 30 }, manifestHash: 'e'.repeat(64) }) } })
    const people = mediaLibrarySearchField(['Ana Martins'], 'people')
    const topics = mediaLibrarySearchField(['Produto Premium'], 'topics')
    for (const [index, artifact] of artifacts.entries()) await prisma.v2MediaLibraryEntry.create({ data: {
      artifactId: artifact.id, workspaceId: artifact.workspaceId, label: `Asset ${index}`,
      peopleJson: stableSerialize(index < 2 ? people.values : []), peopleSearch: index < 2 ? people.search : '\n',
      topicsJson: stableSerialize(index < 2 ? topics.values : []), topicsSearch: index < 2 ? topics.search : '\n',
      originType: 'upload', ...(index === 0 ? { thumbnailArtifactId: thumbnailId } : {}), createdAt: new Date(`2026-08-08T12:0${index}:00.000Z`),
    } })
    for (const [index, artifactId] of artifactIds.slice(0, 3).entries()) {
      const snapshot = createAssetRightsSnapshot({
        id: `library-rights-${index}-${suffix}`, workspaceId, artifactId, sequence: 1,
        draft: index === 2
          ? { status: 'restricted', allowedUses: [], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] } }
          : { status: 'approved', allowedUses: ['editorial-reuse'], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] } },
        createdBy: { type: 'user', id: 'integration-test' }, createdAt: '2026-08-08T10:00:00.000Z',
      })
      await prisma.v2AssetRightsSnapshot.create({ data: rightsRow(snapshot) })
      await prisma.v2MediaArtifact.update({ where: { id: artifactId }, data: { currentRightsSnapshotId: snapshot.id, rightsRevision: 1 } })
    }

    const first = await repository.list({ workspaceId, person: 'ana martins', topic: 'premium', rightsStatus: 'eligible', limit: 1 }, new Date('2026-08-08T13:00:00.000Z'))
    assert.equal(first.items.length, 1)
    assert.equal(first.items[0].id, artifactIds[1])
    assert.ok(first.nextCursor)
    const second = await repository.list({ workspaceId, person: 'ana martins', topic: 'premium', rightsStatus: 'eligible', limit: 1, after: first.nextCursor }, new Date('2026-08-08T13:00:00.000Z'))
    assert.deepEqual(second.items.map((item) => item.id), [artifactIds[0]])
    assert.equal((await repository.list({ workspaceId, rightsStatus: 'restricted' }, new Date('2026-08-08T13:00:00.000Z'))).items[0].id, artifactIds[2])
    assert.equal((await repository.list({ workspaceId }, new Date('2026-08-08T13:00:00.000Z'))).items.some((item) => item.id === artifactIds[3]), false)

    const attach = attachMediaLibraryItemService({ repository, clock: () => new Date('2026-08-08T13:00:00.000Z') })
    const created = await attach({ workspaceId, projectId, artifactId: artifactIds[0] })
    const replay = await attach({ workspaceId, projectId, artifactId: artifactIds[0] })
    assert.equal(created.bytesDuplicated, false)
    assert.equal(created.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.id, created.id)
    assert.equal(await prisma.v2ProjectMediaAsset.count({ where: { projectId, artifactId: artifactIds[0], role: 'selected-insert' } }), 1)
    assert.equal((await prisma.v2MediaArtifact.findUnique({ where: { id: artifactIds[0] } })).byteSize, 1111n)
    await assert.rejects(() => attach({ workspaceId, projectId, artifactId: artifactIds[2] }), /rights/i)
    await assert.rejects(() => attach({ workspaceId, projectId, artifactId: artifactIds[3] }), /not found/i)

    const imageId = artifactIds[2]
    const thumbnailId = `library-image-thumb-${suffix}`
    const previewId = `library-image-preview-${suffix}`
    for (const [id, sha] of [[thumbnailId, '7'.repeat(64)], [previewId, '8'.repeat(64)]]) await prisma.v2MediaArtifact.create({ data: { id, workspaceId, artifactKey: `${workspaceId}/${id}`, sha256: sha, byteSize: 321n, mediaType: 'image', container: 'webp', status: 'available' } })
    const manifestId = `manifest-${imageId}`
    await prisma.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId: imageId, schemaVersion: 'media-artifact-manifest/v1', manifestHash: '9'.repeat(64), recipeId: 'upload', recipeVersion: '1.0.0', parametersHash: 'a'.repeat(64), manifestJson: stableSerialize({ schemaVersion: 'media-artifact-manifest/v1', artifact: { artifactKey: `${workspaceId}/${imageId}`, sha256: '3'.repeat(64), byteSize: 3333, mediaType: 'image', container: 'png' }, recipe: { id: 'upload', version: '1.0.0', parametersHash: 'a'.repeat(64) }, sources: [], manifestHash: '9'.repeat(64) }) } })
    const analysis = createImageAnalysis({ id: `analysis-${imageId}`, workspaceId, artifactId: imageId, manifestId, sourceSha256: '3'.repeat(64), dimensions: { width: 1080, height: 1350 }, dominantColors: ['#102030'], ocr: { state: 'available', values: [{ text: 'Oferta premium', language: 'pt-BR', box: [0.1, 0.2, 0.8, 0.4], confidence: 0.97, importance: 'high' }], producer: { provider: 'tesseract', model: 'por-eng', version: 'v5' }, reasonCodes: [] }, faces: { state: 'available', values: [], producer: { provider: 'vision', model: 'detector', version: 'v1' }, reasonCodes: [] }, objects: { state: 'available', values: [{ label: 'produto', box: [0.1, 0.1, 0.5, 0.5], confidence: 0.94 }], producer: { provider: 'vision', model: 'detector', version: 'v1' }, reasonCodes: [] }, observedDescription: 'Imagem de produto com oferta premium.', inferredTags: [{ value: 'produto', confidence: 0.94, provenance: 'vision@v1:object' }], derivatives: { thumbnailArtifactId: thumbnailId, previewArtifactId: previewId, immutableOriginal: true }, createdAt: '2026-08-08T12:30:00.000Z' })
    await imageRepository.persist(analysis)
    await assert.rejects(() => imageRepository.reuse({ workspaceId, projectId, artifactId: imageId, usage: 'card', text: 'oferta premium', createdAt: '2026-08-08T13:00:00.000Z' }), /rights/i)
    const approved = createAssetRightsSnapshot({ id: `library-image-rights-approved-${suffix}`, workspaceId, artifactId: imageId, sequence: 2, draft: { status: 'approved', allowedUses: ['editorial-reuse'], prohibitedUses: [], consent: { status: 'approved', allowedUses: ['editorial-reuse'] } }, createdBy: { type: 'user', id: 'integration-test' }, createdAt: '2026-08-08T12:45:00.000Z' })
    await prisma.v2AssetRightsSnapshot.create({ data: rightsRow(approved) })
    await prisma.v2MediaArtifact.update({ where: { id: imageId }, data: { currentRightsSnapshotId: approved.id, rightsRevision: 2 } })
    const ranked = await imageRepository.searchReusable({ workspaceId, text: 'oferta premium', usage: 'card', limit: 5 }, new Date('2026-08-08T13:00:00.000Z'))
    assert.equal(ranked[0].artifactId, imageId)
    assert.equal(ranked[0].usage, 'card')
    const reused = await imageRepository.reuse({ workspaceId, projectId, artifactId: imageId, usage: 'card', text: 'oferta premium', createdAt: '2026-08-08T13:00:00.000Z' })
    const replayedReuse = await imageRepository.reuse({ workspaceId, projectId, artifactId: imageId, usage: 'card', text: 'oferta premium', createdAt: '2026-08-08T13:01:00.000Z' })
    assert.equal(reused.bytesDuplicated, false)
    assert.equal(reused.replayed, false)
    assert.equal(replayedReuse.replayed, true)
    assert.equal(replayedReuse.id, reused.id)
    assert.equal(await prisma.v2ImageReuseReference.count({ where: { workspaceId, projectId, artifactId: imageId, usage: 'card' } }), 1)
    assert.equal((await prisma.v2MediaArtifact.findUnique({ where: { id: imageId } })).byteSize, 3333n)

    const createSegment = createMediaSegmentService({ repository: segmentRepository, clock: () => new Date('2026-08-08T13:00:00.000Z') })
    const firstSegment = await createSegment({ workspaceId, artifactId: artifactIds[0], label: 'Promessa', startMs: 0, endMs: 5000 })
    const overlap = await createSegment({ workspaceId, artifactId: artifactIds[0], label: 'Prova', startMs: 4000, endMs: 8000 })
    const nested = await createSegment({ workspaceId, artifactId: artifactIds[0], parentSegmentId: firstSegment.segment.id, label: 'Frase', startMs: 1000, endMs: 5000 })
    const edge = await createSegment({ workspaceId, artifactId: artifactIds[0], label: 'Tudo', startMs: 0, endMs: 10000 })
    const replayed = await createSegment({ workspaceId, artifactId: artifactIds[0], label: 'Tudo', startMs: 0, endMs: 10000 })
    assert.equal(firstSegment.segment.physicalObjectKey, null)
    assert.equal(overlap.segment.semanticRange.startMs, 4000)
    assert.equal(nested.segment.parentSegmentId, firstSegment.segment.id)
    assert.equal(edge.replayed, false)
    assert.equal(replayed.replayed, true)
    assert.equal((await segmentRepository.list(workspaceId, artifactIds[0])).length, 4)
    assert.equal((await prisma.v2MediaArtifact.findUnique({ where: { id: artifactIds[0] } })).byteSize, 1111n)
    const segmentPage = await repository.list({ workspaceId, kind: 'segment', person: 'ana martins', topic: 'premium', rightsStatus: 'eligible' }, new Date('2026-08-08T13:01:00.000Z'))
    assert.equal(segmentPage.items.length, 4)
    assert.equal(segmentPage.items.every((item) => item.kind === 'segment' && item.source.virtual && item.source.bytesDuplicated === false && item.source.physicalObjectKey === null), true)
    assert.equal(segmentPage.items.every((item) => item.source.artifactId === artifactIds[0] && item.technical.byteSize === '1111'), true)
    assert.equal(segmentPage.items.every((item) => item.people[0] === 'Ana Martins' && item.topics[0] === 'Produto Premium'), true)
    assert.equal(segmentPage.items.every((item) => item.preview.thumbnail.artifactId === thumbnailId), true)
    assert.deepEqual((await repository.findById(workspaceId, nested.segment.id, new Date('2026-08-08T13:01:00.000Z'))).source.semanticRange, { startMs: 1000, endMs: 5000 })
    assert.equal(await repository.findById(otherWorkspaceId, nested.segment.id, new Date('2026-08-08T13:01:00.000Z')), null)

    const unifiedIds = []
    let after
    do {
      const page = await repository.list({ workspaceId, person: 'ana martins', limit: 2, ...(after ? { after } : {}) }, new Date('2026-08-08T13:01:00.000Z'))
      unifiedIds.push(...page.items.map((item) => item.id))
      after = page.nextCursor ?? undefined
    } while (after)
    assert.deepEqual(new Set(unifiedIds).size, unifiedIds.length)
    assert.equal(unifiedIds.filter((id) => id.startsWith('segment-')).length, 4)
    assert.deepEqual(unifiedIds.slice(-2), [artifactIds[1], artifactIds[0]])
    const scopedCursor = (await repository.list({ workspaceId, kind: 'segment', limit: 1 }, new Date('2026-08-08T13:01:00.000Z'))).nextCursor
    await assert.rejects(() => repository.list({ workspaceId, kind: 'video', limit: 1, after: scopedCursor }, new Date('2026-08-08T13:01:00.000Z')), /cursor/i)
    await assert.rejects(() => createSegment({ workspaceId, artifactId: artifactIds[0], parentSegmentId: firstSegment.segment.id, label: 'Fora', startMs: 0, endMs: 6000 }), /inside|parent/i)
    await assert.rejects(() => createSegment({ workspaceId: otherWorkspaceId, artifactId: artifactIds[0], label: 'Cross workspace', startMs: 0, endMs: 1000 }), /not found/i)
  } finally {
    await cleanup()
    await prisma.$disconnect()
  }
})
