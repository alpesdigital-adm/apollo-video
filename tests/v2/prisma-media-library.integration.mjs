import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { attachMediaLibraryItemService } from '../../src/v2/application/media-library.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { mediaLibrarySearchField } from '../../src/v2/domain/media-library.ts'
import { PrismaMediaLibraryRepository } from '../../src/v2/infrastructure/prisma/media-library-repository.ts'

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
  const artifactIds = ['video', 'audio', 'restricted', 'other'].map((kind) => `library-${kind}-${suffix}`)
  const cleanup = async () => {
    await prisma.v2ProjectMediaAsset.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    await prisma.v2MediaArtifact.updateMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } }, data: { currentRightsSnapshotId: null } })
    await prisma.v2MediaLibraryEntry.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
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
    const people = mediaLibrarySearchField(['Ana Martins'], 'people')
    const topics = mediaLibrarySearchField(['Produto Premium'], 'topics')
    for (const [index, artifact] of artifacts.entries()) await prisma.v2MediaLibraryEntry.create({ data: {
      artifactId: artifact.id, workspaceId: artifact.workspaceId, label: `Asset ${index}`,
      peopleJson: stableSerialize(index < 2 ? people.values : []), peopleSearch: index < 2 ? people.search : '\n',
      topicsJson: stableSerialize(index < 2 ? topics.values : []), topicsSearch: index < 2 ? topics.search : '\n',
      originType: 'upload', createdAt: new Date(`2026-08-08T12:0${index}:00.000Z`),
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
  } finally {
    await cleanup()
    await prisma.$disconnect()
  }
})
