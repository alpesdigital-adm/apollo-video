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
  const { createMediaArtifactManifest } = await import(
    '../../src/v2/domain/media-artifact.ts'
  )
  const { PrismaPublicOperationRepository } = await import(
    '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
  )
  const { PrismaArtifactRenderCheckpointRepository } = await import(
    '../../src/v2/infrastructure/prisma/artifact-render-checkpoint-repository.ts'
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
  const artifactKey = 'workspaces/operation/render-target.mp4'
  const targetManifest = createMediaArtifactManifest({
    artifactKey,
    artifactSha256: sha('a'),
    byteSize: 1024,
    mediaType: 'video',
    container: 'mp4',
    recipe: { id: 'render-video', version: 'v1', parameters: { fixture: true } },
    probe: { width: 1080, height: 1920, duration: 2, fps: 30 },
  })

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
        artifactKey,
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
        manifestHash: targetManifest.manifestHash,
        recipeId: 'render-video',
        recipeVersion: 'v1',
        parametersHash: targetManifest.recipe.parametersHash,
        manifestJson: JSON.stringify(targetManifest),
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
    const checkpoints = new PrismaArtifactRenderCheckpointRepository(client)
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

    const claimInputs = ['worker-integration-one', 'worker-integration-two'].map(
      (leaseOwner) => ({
        workspaceId,
        leaseOwner,
        now: '2026-01-01T15:31:00.000Z',
        leaseUntil: '2026-01-01T15:31:30.000Z',
      }),
    )
    const claims = process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? await Promise.all(claimInputs.map((claim) => repository.claimNext(claim)))
      : [
          await repository.claimNext(claimInputs[0]),
          await repository.claimNext(claimInputs[1]),
        ]
    assert.equal(claims.filter(Boolean).length, 1)
    const firstClaim = claims.find(Boolean)
    const firstOwner = firstClaim.lease.owner
    const recoveryOwner = firstOwner === claimInputs[0].leaseOwner
      ? claimInputs[1].leaseOwner
      : claimInputs[0].leaseOwner
    assert.equal(firstClaim.operation.attempt, 1)
    assert.equal(firstClaim.operation.phase, 'materializing')
    assert.equal(
      await repository.heartbeat({
        operationId,
        leaseOwner: firstOwner,
        attempt: 0,
        now: '2026-01-01T15:31:10.000Z',
        leaseUntil: '2026-01-01T15:31:40.000Z',
      }),
      false,
    )
    assert.equal(
      await repository.heartbeat({
        operationId,
        leaseOwner: firstOwner,
        attempt: 1,
        now: '2026-01-01T15:31:10.000Z',
        leaseUntil: '2026-01-01T15:31:40.000Z',
      }),
      true,
    )

    const recovered = await repository.claimNext({
      workspaceId,
      leaseOwner: recoveryOwner,
      now: '2026-01-01T15:31:41.000Z',
      leaseUntil: '2026-01-01T15:32:11.000Z',
    })
    assert.equal(recovered.operation.attempt, 2)
    assert.equal(recovered.operation.startedAt, firstClaim.operation.startedAt)
    assert.equal(
      await repository.advancePhase({
        operationId,
        leaseOwner: firstOwner,
        attempt: 1,
        phase: 'rendering',
        now: '2026-01-01T15:31:42.000Z',
      }),
      false,
    )
    for (const [phase, timestamp] of [
      ['rendering', '2026-01-01T15:31:42.000Z'],
      ['verifying', '2026-01-01T15:31:43.000Z'],
      ['persisting', '2026-01-01T15:31:44.000Z'],
    ]) {
      assert.equal(
        await repository.advancePhase({
          operationId,
          leaseOwner: recoveryOwner,
          attempt: 2,
          phase,
          now: timestamp,
        }),
        true,
      )
    }
    assert.equal(
      await repository.succeed({
        operationId,
        leaseOwner: firstOwner,
        attempt: 1,
        now: '2026-01-01T15:31:45.000Z',
      }),
      null,
    )
    await assert.rejects(
      repository.succeed({
        operationId,
        leaseOwner: recoveryOwner,
        attempt: 2,
        now: '2026-01-01T15:31:45.000Z',
      }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    const output = {
      schemaVersion: 'committed-render-receipt/v1',
      stageId: 'operation-stage-two',
      inputHash: sha('d'),
      outputSha256: sha('a'),
      byteSize: 1024,
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 60,
      codec: 'h264',
      container: 'mp4',
      committedAt: '2026-01-01T15:31:44.500Z',
    }
    assert.equal(
      await checkpoints.record({
        operationId,
        leaseOwner: firstOwner,
        attempt: 1,
        now: '2026-01-01T15:31:45.000Z',
        outputKey: 'workspaces/operation/renders/output.mp4',
        output,
      }),
      null,
    )
    const checkpointed = await checkpoints.record({
      operationId,
      leaseOwner: recoveryOwner,
      attempt: 2,
      now: '2026-01-01T15:31:45.000Z',
      outputKey: 'workspaces/operation/renders/output.mp4',
      output,
    })
    assert.equal(checkpointed.replayed, false)
    const checkpointReplay = await checkpoints.record({
      operationId,
      leaseOwner: recoveryOwner,
      attempt: 2,
      now: '2026-01-01T15:31:45.500Z',
      outputKey: 'workspaces/operation/renders/output.mp4',
      output: {
        ...output,
        stageId: 'recovered-operation-stage',
        committedAt: '2026-01-01T15:31:44.750Z',
      },
    })
    assert.equal(checkpointReplay.replayed, true)
    assert.equal(checkpointReplay.checkpoint.attempt, 2)
    const succeeded = await repository.succeed({
      operationId,
      leaseOwner: recoveryOwner,
      attempt: 2,
      now: '2026-01-01T15:31:46.000Z',
    })
    assert.equal(succeeded.operation.status, 'succeeded')
    assert.deepEqual(succeeded.operation.result.resource, operation.target)
    assert.equal(JSON.stringify(succeeded).includes('worker-integration'), false)
    assert.equal(JSON.stringify(succeeded).includes('workspaces/operation/renders'), false)
    assert.equal(
      (await checkpoints.findByOperationId(operationId)).outputKey,
      'workspaces/operation/renders/output.mp4',
    )
    const terminalRow = await client.v2PublicOperation.findUnique({ where: { id: operationId } })
    assert.equal(terminalRow.leaseOwner, null)
    assert.equal(terminalRow.leaseExpiresAt, null)
    assert.equal(terminalRow.heartbeatAt, null)

    const exhaustedOperation = createQueuedPublicOperation({
      ...operation,
      id: 'operation-integration-exhausted',
      maxAttempts: 1,
      createdAt: '2026-01-01T15:32:00.000Z',
    })
    await repository.createOrReplay({
      operation: exhaustedOperation,
      context: input.context,
      idempotencyKey: 'operation-exhausted-request',
      requestFingerprint: sha('8'),
    })
    await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-exhausted',
      now: '2026-01-01T15:33:00.000Z',
      leaseUntil: '2026-01-01T15:33:30.000Z',
    })
    assert.equal(
      await repository.claimNext({
        workspaceId,
        leaseOwner: 'worker-integration-recovery',
        now: '2026-01-01T15:33:31.000Z',
        leaseUntil: '2026-01-01T15:34:01.000Z',
      }),
      null,
    )
    const exhausted = await repository.findById(workspaceId, exhaustedOperation.id)
    assert.equal(exhausted.operation.status, 'failed')
    assert.equal(exhausted.operation.error.code, 'worker_lease_expired')
    assert.equal(JSON.stringify(exhausted).includes('worker-integration-exhausted'), false)

    await client.v2ArtifactRenderOperation.update({
      where: { operationId },
      data: { outputSha256: sha('b') },
    })
    await assert.rejects(
      repository.findById(workspaceId, operationId),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    await assert.rejects(
      checkpoints.findByOperationId(operationId),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    await client.v2ArtifactRenderOperation.update({
      where: { operationId },
      data: { outputSha256: sha('a') },
    })

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
