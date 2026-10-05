import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { PrismaMediaLibraryPreviewRepository } from '../../src/v2/infrastructure/prisma/media-library-preview-repository.ts'

test('PostgreSQL preview publication rejects canceled, expired and replaced ingest leases', { skip: !process.env.V2_DATABASE_URL }, async () => {
  const prisma = new PrismaClient(), suffix = randomUUID().slice(0, 8)
  const workspaceId = `preview-fence-${suffix}`, clientId = `preview-client-${suffix}`, operationId = `preview-op-${suffix}`
  const sourceId = `preview-source-${suffix}`, thumbnailId = `preview-thumb-${suffix}`
  const projectId = `preview-project-${suffix}`
  const repository = new PrismaMediaLibraryPreviewRepository(prisma)
  const input = { workspaceId, operationId, leaseOwner: 'preview-worker', attempt: 1, artifactId: sourceId, thumbnailArtifactId: thumbnailId, label: 'Source', createdAt: new Date().toISOString() }
  try {
    await prisma.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Preview fence' } })
    await prisma.v2ApiClient.create({ data: { id: clientId, workspaceId, name: 'Preview fence', allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '[]', createdBy: 'test-owner' } })
    await prisma.v2Project.create({ data: { id: projectId, workspaceId, name: 'Preview fence', locale: 'pt-BR', createdByType: 'user', createdById: 'test-owner' } })
    for (const [id, mediaType, container, sha] of [[sourceId, 'video', 'mp4', 'a'], [thumbnailId, 'image', 'png', 'b']]) await prisma.v2MediaArtifact.create({ data: { id, workspaceId, artifactKey: `${workspaceId}/${id}`, mediaType, container, sha256: sha.repeat(64), byteSize: 12n, status: 'available' } })
    const past = new Date(Date.now() - 30000)
    await prisma.v2PublicOperation.create({ data: { id: operationId, workspaceId, clientId, projectId, type: 'media-ingest', status: 'running', phase: 'persisting', progressCompleted: 5, progressTotal: 6, progressUnit: 'stage', targetType: 'media-artifact', targetId: sourceId, attempt: 1, idempotencyKey: `preview-${suffix}`, requestFingerprint: 'a'.repeat(64), createdAt: past, startedAt: past, heartbeatAt: past, leaseOwner: input.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60000) } })
    await assert.rejects(() => repository.publish({ ...input, leaseOwner: 'stale-worker' }), /unexpired ingest lease/i)
    await assert.rejects(() => repository.publish({ ...input, attempt: 2 }), /unexpired ingest lease/i)
    assert.equal(await prisma.v2MediaLibraryEntry.count({ where: { workspaceId } }), 0)
    await prisma.v2PublicOperation.update({ where: { id: operationId }, data: { leaseExpiresAt: new Date(Date.now() - 10000) } })
    await assert.rejects(() => repository.publish(input), /unexpired ingest lease/i)
    assert.equal(await prisma.v2MediaLibraryEntry.count({ where: { workspaceId } }), 0)
    await prisma.v2PublicOperation.update({ where: { id: operationId }, data: { leaseOwner: 'replacement-worker', attempt: 2, heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60000) } })
    await assert.rejects(() => repository.publish(input), /unexpired ingest lease/i)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(() => repository.publish({ ...input, leaseOwner: 'replacement-worker', attempt: 2, signal: aborted.signal }), /unexpired ingest lease/i)
    assert.equal(await prisma.v2MediaLibraryEntry.count({ where: { workspaceId } }), 0)
    await repository.publish({ ...input, leaseOwner: 'replacement-worker', attempt: 2 })
    assert.equal((await prisma.v2MediaLibraryEntry.findUnique({ where: { artifactId: sourceId } })).thumbnailArtifactId, thumbnailId)
    await prisma.v2MediaLibraryEntry.deleteMany({ where: { workspaceId } })
    // Real SQL upsert executes, then cancellation arrives before commit. The
    // repository's final fence must roll that insert back in the same transaction.
    const duringUpsert = new AbortController()
    const abortingRepository = new PrismaMediaLibraryPreviewRepository({ $transaction: (run) => prisma.$transaction((tx) => run(new Proxy(tx, { get(target, key) {
      if (key === 'v2MediaLibraryEntry') return new Proxy(target.v2MediaLibraryEntry, { get(model, method) {
        if (method === 'upsert') return async (args) => { const result = await model.upsert(args); duringUpsert.abort(); return result }
        return Reflect.get(model, method)
      } })
      return Reflect.get(target, key)
    } }))) })
    await assert.rejects(() => abortingRepository.publish({ ...input, leaseOwner: 'replacement-worker', attempt: 2, signal: duringUpsert.signal }), /unexpired ingest lease/i)
    assert.equal(await prisma.v2MediaLibraryEntry.count({ where: { workspaceId } }), 0)
    await prisma.v2PublicOperation.update({ where: { id: operationId }, data: { status: 'canceled', phase: 'canceled', cancelable: false, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null } })
    await assert.rejects(() => repository.publish({ ...input, leaseOwner: 'replacement-worker', attempt: 2 }), /unexpired ingest lease/i)
    assert.equal(await prisma.v2MediaLibraryEntry.count({ where: { workspaceId } }), 0)
  } finally {
    await prisma.v2MediaLibraryEntry.deleteMany({ where: { workspaceId } })
    await prisma.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await prisma.v2Project.deleteMany({ where: { workspaceId } })
    await prisma.v2ApiClient.deleteMany({ where: { workspaceId } })
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
    await prisma.$disconnect()
  }
})
