import assert from 'node:assert/strict'
import test from 'node:test'

test('media artifacts persist atomically with workspace-scoped immutable lineage', async () => {
  const clientPackage =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? '../../generated/prisma-v2/index.js'
      : '@prisma/client'
  const { PrismaClient } = await import(clientPackage)
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { createMediaArtifactManifest } = await import(
    '../../src/v2/domain/media-artifact.ts'
  )
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { PrismaMediaArtifactRepository } = await import(
    '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )

  const client = new PrismaClient()
  const workspaceA = 'artifact-integration-workspace-a'
  const workspaceB = 'artifact-integration-workspace-b'
  const workspaceIds = [workspaceA, workspaceB]
  const sha = (character) => character.repeat(64)
  const createManifest = ({ artifactKey, artifactSha256, sources = [], parameters = {} }) =>
    createMediaArtifactManifest({
      artifactKey,
      artifactSha256,
      byteSize: 1024,
      mediaType: 'video',
      container: 'mp4',
      recipe: { id: sources.length === 0 ? 'ingest-source' : 'normalize-video', version: 'v1', parameters },
      sources,
      probe: { width: 320, height: 240, duration: 3, fps: 30 },
    })
  const expectDomainCode = async (promise, code) => {
    await assert.rejects(promise, (error) => error instanceof DomainError && error.code === code)
  }
  const cleanup = async () => {
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2Workspace.deleteMany({ where: { id: { in: workspaceIds } } })
  }

  try {
    await cleanup()
    const workspaces = new PrismaWorkspaceRepository(client)
    await workspaces.create(
      createWorkspace({
        id: workspaceA,
        slug: 'artifact-integration-a',
        name: 'Artifact Integration A',
        status: 'active',
        createdAt: '2026-07-13T00:40:00.000Z',
      }),
    )
    await workspaces.create(
      createWorkspace({
        id: workspaceB,
        slug: 'artifact-integration-b',
        name: 'Artifact Integration B',
        status: 'active',
        createdAt: '2026-07-13T00:40:00.000Z',
      }),
    )

    const repository = new PrismaMediaArtifactRepository(client)
    const sourceKey = 'workspaces/a/masters/source.mp4'
    const sourceManifest = createManifest({ artifactKey: sourceKey, artifactSha256: sha('a') })
    const source = await repository.persistOrReplay({
      workspaceId: workspaceA,
      artifactId: 'artifact-source-a',
      manifestId: 'manifest-source-a',
      lineageIds: [],
      manifest: sourceManifest,
      createdAt: '2026-07-13T00:41:00.000Z',
    })
    assert.equal(source.replayed, false)

    const derivedManifest = createManifest({
      artifactKey: 'workspaces/a/artifacts/normalized.mp4',
      artifactSha256: sha('b'),
      parameters: { crf: 23 },
      sources: [{ artifactKey: sourceKey, sha256: sha('a'), role: 'primary' }],
    })
    const derivedBundle = {
      workspaceId: workspaceA,
      artifactId: 'artifact-derived-a',
      manifestId: 'manifest-derived-a',
      lineageIds: ['lineage-derived-a-0'],
      manifest: derivedManifest,
      createdAt: '2026-07-13T00:42:00.000Z',
    }
    const first = await repository.persistOrReplay(derivedBundle)
    const replay = await repository.persistOrReplay({
      ...derivedBundle,
      artifactId: 'ignored-artifact-id',
      manifestId: 'ignored-manifest-id',
      lineageIds: ['ignored-lineage-id'],
    })
    assert.deepEqual(first, {
      artifactId: 'artifact-derived-a',
      manifestId: 'manifest-derived-a',
      replayed: false,
    })
    assert.deepEqual(replay, { ...first, replayed: true })

    await expectDomainCode(
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'conflicting-source',
        manifestId: 'conflicting-source-manifest',
        lineageIds: [],
        manifest: createManifest({ artifactKey: sourceKey, artifactSha256: sha('c') }),
        createdAt: '2026-07-13T00:43:00.000Z',
      }),
      'PERSISTENCE_CONFLICT',
    )

    const missingSourceOutputKey = 'workspaces/b/artifacts/should-rollback.mp4'
    await expectDomainCode(
      repository.persistOrReplay({
        workspaceId: workspaceB,
        artifactId: 'artifact-rollback-b',
        manifestId: 'manifest-rollback-b',
        lineageIds: ['lineage-rollback-b-0'],
        manifest: createManifest({
          artifactKey: missingSourceOutputKey,
          artifactSha256: sha('d'),
          sources: [{ artifactKey: sourceKey, sha256: sha('a'), role: 'primary' }],
        }),
        createdAt: '2026-07-13T00:44:00.000Z',
      }),
      'MEDIA_ARTIFACT_SOURCE_NOT_FOUND',
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId: workspaceB, artifactKey: missingSourceOutputKey },
      }),
      0,
    )

    const checksumMismatchKey = 'workspaces/a/artifacts/checksum-rollback.mp4'
    await expectDomainCode(
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-checksum-rollback',
        manifestId: 'manifest-checksum-rollback',
        lineageIds: ['lineage-checksum-rollback-0'],
        manifest: createManifest({
          artifactKey: checksumMismatchKey,
          artifactSha256: sha('f'),
          sources: [{ artifactKey: sourceKey, sha256: sha('9'), role: 'primary' }],
        }),
        createdAt: '2026-07-13T00:44:30.000Z',
      }),
      'PERSISTENCE_CONFLICT',
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId: workspaceA, artifactKey: checksumMismatchKey },
      }),
      0,
    )

    await assert.rejects(
      client.v2MediaArtifact.create({
        data: {
          id: 'artifact-invalid-key',
          workspaceId: workspaceA,
          artifactKey: '/absolute/path.mp4',
          sha256: sha('1'),
          byteSize: 1n,
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
        },
      }),
    )

    const concurrentManifest = createManifest({
      artifactKey: 'workspaces/a/artifacts/concurrent.mp4',
      artifactSha256: sha('e'),
      sources: [{ artifactKey: sourceKey, sha256: sha('a'), role: 'primary' }],
    })
    const concurrent = await Promise.all([
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-concurrent-1',
        manifestId: 'manifest-concurrent-1',
        lineageIds: ['lineage-concurrent-1'],
        manifest: concurrentManifest,
        createdAt: '2026-07-13T00:45:00.000Z',
      }),
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-concurrent-2',
        manifestId: 'manifest-concurrent-2',
        lineageIds: ['lineage-concurrent-2'],
        manifest: concurrentManifest,
        createdAt: '2026-07-13T00:45:00.000Z',
      }),
    ])
    assert.deepEqual(concurrent.map((result) => result.replayed).sort(), [false, true])

    assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId: workspaceA } }), 3)
    assert.equal(await client.v2MediaArtifactManifest.count({ where: { workspaceId: workspaceA } }), 3)
    assert.equal(await client.v2MediaArtifactLineage.count({ where: { workspaceId: workspaceA } }), 2)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
