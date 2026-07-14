import assert from 'node:assert/strict'
import test from 'node:test'

test('PublicOperation persistence is idempotent, workspace-scoped and integrity checked', async () => {
  const clientPackage =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? '../../generated/prisma-v2/index.js'
      : '@prisma/client'
  const { PrismaClient } = await import(clientPackage)
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { createQueuedPublicOperation } = await import(
    '../../src/v2/domain/public-operation.ts'
  )
  const { PrismaPublicOperationRepository } = await import(
    '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
  )

  const client = new PrismaClient()
  const workspaceId = 'operation-integration-workspace'
  const clientId = 'operation-integration-client'
  const artifactId = 'operation-integration-artifact'
  const manifestId = 'operation-integration-manifest'
  const authorizationId = 'operation-integration-authorization'
  const operationId = 'operation-integration-render-1'
  const sha = (character) => character.repeat(64)
  // Keep fixture dates in the past because Prisma's @updatedAt uses the database
  // execution clock when corruption scenarios update the stored record.
  const now = new Date('2026-01-01T15:30:00.000Z')

  const cleanup = async () => {
    await client.v2ArtifactRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2AssetUseDecision.deleteMany({ where: { workspaceId } })
    await client.v2MaterializationAuthorization.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ApiCredential.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: 'operation-integration',
        name: 'Operation Integration',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    })
    await client.v2ApiClient.create({
      data: {
        id: clientId,
        workspaceId,
        name: 'Operation Integration Client',
        status: 'active',
        environment: 'sandbox',
        scopesJson: JSON.stringify(['artifacts:render', 'operations:read']),
        secretSalt: 'integration-salt',
        secretHash: sha('1'),
        createdAt: now,
        updatedAt: now,
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey: 'workspaces/operation/render-target.mp4',
        sha256: sha('a'),
        byteSize: 1024n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt: now,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: manifestId,
        workspaceId,
        artifactId,
        schemaVersion: 'media-artifact-manifest/v1',
        manifestHash: sha('b'),
        recipeId: 'render-video',
        recipeVersion: 'v1',
        parametersHash: sha('c'),
        manifestJson: JSON.stringify({ fixture: 'operation-integration' }),
        createdAt: now,
      },
    })
    await client.v2MaterializationAuthorization.create({
      data: {
        id: authorizationId,
        workspaceId,
        artifactId,
        manifestId,
        inputHash: sha('d'),
        rightsUse: 'paid-ad',
        locale: 'pt-BR',
        syntheticOpsJson: '[]',
        status: 'authorized',
        issuesJson: '[]',
        clientId,
        idempotencyKey: 'operation-authorization',
        requestFingerprint: sha('e'),
        evaluatedAt: now,
        validUntil: new Date(now.getTime() + 300_000),
        createdAt: now,
      },
    })

    const repository = new PrismaPublicOperationRepository(client)
    const operation = createQueuedPublicOperation({
      id: operationId,
      workspaceId,
      clientId,
      type: 'artifact-render',
      target: { type: 'media-artifact', id: artifactId, manifestId },
      createdAt: now.toISOString(),
    })
    const input = {
      operation,
      context: { authorizationId, inputHash: sha('d') },
      idempotencyKey: 'operation-render-request',
      requestFingerprint: sha('f'),
    }
    const created = await repository.createOrReplay(input)
    const replayed = await repository.createOrReplay({
      ...input,
      operation: { ...operation, id: 'operation-ignored-on-replay' },
    })
    assert.equal(created.replayed, false)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.operation.id, operationId)
    assert.deepEqual(replayed.context, input.context)
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ArtifactRenderOperation.count({ where: { workspaceId } }), 1)
    assert.equal(await repository.findById('another-workspace', operationId), null)

    await assert.rejects(
      repository.findReplay({
        workspaceId,
        clientId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: sha('0'),
      }),
      (error) =>
        error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )

    const storedCore = await client.v2PublicOperation.findUnique({ where: { id: operationId } })
    assert.equal(storedCore.resultJson, null)
    assert.equal(JSON.stringify(storedCore).includes(authorizationId), false)
    assert.equal(JSON.stringify(storedCore).includes(sha('d')), false)

    await client.v2PublicOperation.update({
      where: { id: operationId },
      data: { targetId: 'corrupt-operation-target' },
    })
    await assert.rejects(
      repository.findById(workspaceId, operationId),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    await client.v2PublicOperation.update({
      where: { id: operationId },
      data: { targetId: artifactId },
    })
    await client.v2ArtifactRenderOperation.update({
      where: { operationId },
      data: { inputHash: sha('9') },
    })
    await assert.rejects(
      repository.findById(workspaceId, operationId),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
