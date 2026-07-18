import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('PublicOperation persistence is idempotent, workspace-scoped and integrity checked', async () => {
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
    const concurrentResults = await Promise.all([
      repository.createOrReplay(input),
      repository.createOrReplay({
        ...input,
        operation: { ...operation },
      }),
    ])
    const created = concurrentResults.find((result) => result.replayed === false)
    const replayed = concurrentResults.find((result) => result.replayed === true)
    assert.ok(created)
    assert.ok(replayed)
    assert.equal(created.replayed, false)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.operation.id, operationId)
    assert.deepEqual(replayed.context, { kind: 'artifact-render', ...input.context })
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
    const claims = await Promise.all(claimInputs.map((claim) => repository.claimNext(claim)))
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
    assert.equal(exhausted.operation.deadLetteredAt, exhausted.operation.completedAt)
    assert.equal(JSON.stringify(exhausted).includes('worker-integration-exhausted'), false)

    const scheduledOperation = createQueuedPublicOperation({
      ...operation,
      id: 'operation-integration-scheduled-retry',
      maxAttempts: 2,
      createdAt: '2026-01-01T15:34:00.000Z',
    })
    await repository.createOrReplay({
      operation: scheduledOperation,
      context: input.context,
      idempotencyKey: 'operation-scheduled-retry-request',
      requestFingerprint: sha('7'),
    })
    const scheduledFirst = await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-scheduled-one',
      now: '2026-01-01T15:35:00.000Z',
      leaseUntil: '2026-01-01T15:35:30.000Z',
    })
    const retryScheduled = await repository.failOrRetry({
      operationId: scheduledOperation.id,
      leaseOwner: scheduledFirst.lease.owner,
      attempt: scheduledFirst.lease.attempt,
      now: '2026-01-01T15:35:01.000Z',
      nextAttemptAt: '2026-01-01T15:35:11.000Z',
      error: {
        code: 'render_execution_failed',
        message: 'Render operation could not be completed',
        retryable: true,
      },
    })
    assert.equal(retryScheduled.operation.status, 'retrying')
    assert.equal(retryScheduled.operation.nextAttemptAt, '2026-01-01T15:35:11.000Z')
    assert.equal(
      await repository.claimNext({
        workspaceId,
        leaseOwner: 'worker-integration-too-early',
        now: '2026-01-01T15:35:10.999Z',
        leaseUntil: '2026-01-01T15:35:40.999Z',
      }),
      null,
    )
    const scheduledSecond = await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-scheduled-two',
      now: '2026-01-01T15:35:11.000Z',
      leaseUntil: '2026-01-01T15:35:41.000Z',
    })
    assert.equal(scheduledSecond.operation.attempt, 2)
    assert.equal(scheduledSecond.operation.nextAttemptAt, undefined)
    const scheduledExhausted = await repository.failOrRetry({
      operationId: scheduledOperation.id,
      leaseOwner: scheduledSecond.lease.owner,
      attempt: scheduledSecond.lease.attempt,
      now: '2026-01-01T15:35:12.000Z',
      error: {
        code: 'render_execution_failed',
        message: 'Render operation could not be completed',
        retryable: true,
      },
    })
    assert.equal(scheduledExhausted.operation.status, 'failed')
    assert.equal(
      scheduledExhausted.operation.deadLetteredAt,
      scheduledExhausted.operation.completedAt,
    )

    const cancelQueuedOperation = createQueuedPublicOperation({
      ...operation,
      id: 'operation-integration-cancel-queued',
      createdAt: '2026-01-01T15:36:00.000Z',
    })
    await repository.createOrReplay({
      operation: cancelQueuedOperation,
      context: input.context,
      idempotencyKey: 'operation-cancel-queued-request',
      requestFingerprint: sha('6'),
    })
    assert.equal(
      await repository.cancel({
        workspaceId: 'different-workspace-id',
        operationId: cancelQueuedOperation.id,
        canceledAt: '2026-01-01T15:36:01.000Z',
      }),
      null,
    )
    const canceledQueued = await repository.cancel({
      workspaceId,
      operationId: cancelQueuedOperation.id,
      canceledAt: '2026-01-01T15:36:01.000Z',
    })
    assert.equal(canceledQueued.operation.status, 'canceled')
    assert.equal(canceledQueued.operation.startedAt, undefined)
    const canceledQueuedReplay = await repository.cancel({
      workspaceId,
      operationId: cancelQueuedOperation.id,
      canceledAt: '2026-01-01T15:36:02.000Z',
    })
    assert.equal(canceledQueuedReplay.operation.completedAt, canceledQueued.operation.completedAt)

    const cancelRunningOperation = createQueuedPublicOperation({
      ...operation,
      id: 'operation-integration-cancel-running',
      createdAt: '2026-01-01T15:37:00.000Z',
    })
    await repository.createOrReplay({
      operation: cancelRunningOperation,
      context: input.context,
      idempotencyKey: 'operation-cancel-running-request',
      requestFingerprint: sha('5'),
    })
    const cancelRunningClaim = await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-cancel-running',
      now: '2026-01-01T15:37:01.000Z',
      leaseUntil: '2026-01-01T15:37:31.000Z',
    })
    for (const [phase, timestamp] of [
      ['rendering', '2026-01-01T15:37:01.100Z'],
      ['verifying', '2026-01-01T15:37:01.200Z'],
      ['persisting', '2026-01-01T15:37:01.300Z'],
    ]) {
      assert.equal(
        await repository.advancePhase({
          operationId: cancelRunningOperation.id,
          leaseOwner: cancelRunningClaim.lease.owner,
          attempt: cancelRunningClaim.lease.attempt,
          phase,
          now: timestamp,
        }),
        true,
      )
    }
    const canceledRunning = await repository.cancel({
      workspaceId,
      operationId: cancelRunningOperation.id,
      canceledAt: '2026-01-01T15:37:02.000Z',
    })
    assert.equal(canceledRunning.operation.status, 'canceled')
    assert.equal(canceledRunning.operation.startedAt, cancelRunningClaim.operation.startedAt)
    assert.equal(
      await repository.heartbeat({
        operationId: cancelRunningOperation.id,
        leaseOwner: cancelRunningClaim.lease.owner,
        attempt: cancelRunningClaim.lease.attempt,
        now: '2026-01-01T15:37:03.000Z',
        leaseUntil: '2026-01-01T15:37:33.000Z',
      }),
      false,
    )
    assert.equal(
      await checkpoints.record({
        operationId: cancelRunningOperation.id,
        leaseOwner: cancelRunningClaim.lease.owner,
        attempt: cancelRunningClaim.lease.attempt,
        now: '2026-01-01T15:37:03.000Z',
        outputKey: 'workspaces/operation/renders/canceled-output.mp4',
        output,
      }),
      null,
    )
    assert.equal(
      await repository.advancePhase({
        operationId: cancelRunningOperation.id,
        leaseOwner: cancelRunningClaim.lease.owner,
        attempt: cancelRunningClaim.lease.attempt,
        phase: 'rendering',
        now: '2026-01-01T15:37:03.000Z',
      }),
      false,
    )
    assert.equal(
      await repository.claimNext({
        workspaceId,
        leaseOwner: 'worker-integration-after-cancel',
        now: '2026-01-01T15:38:00.000Z',
        leaseUntil: '2026-01-01T15:38:30.000Z',
      }),
      null,
    )
    const cancelRetryOperation = createQueuedPublicOperation({
      ...operation,
      id: 'operation-integration-cancel-retry',
      createdAt: '2026-01-01T15:38:01.000Z',
    })
    await repository.createOrReplay({
      operation: cancelRetryOperation,
      context: input.context,
      idempotencyKey: 'operation-cancel-retry-request',
      requestFingerprint: sha('4'),
    })
    const cancelRetryClaim = await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-cancel-retry',
      now: '2026-01-01T15:38:02.000Z',
      leaseUntil: '2026-01-01T15:38:32.000Z',
    })
    const retryBeforeCancel = await repository.failOrRetry({
      operationId: cancelRetryOperation.id,
      leaseOwner: cancelRetryClaim.lease.owner,
      attempt: cancelRetryClaim.lease.attempt,
      now: '2026-01-01T15:38:03.000Z',
      nextAttemptAt: '2026-01-01T15:39:03.000Z',
      error: {
        code: 'render_execution_failed',
        message: 'Render operation could not be completed',
        retryable: true,
      },
    })
    assert.equal(retryBeforeCancel.operation.status, 'retrying')
    const canceledRetry = await repository.cancel({
      workspaceId,
      operationId: cancelRetryOperation.id,
      canceledAt: '2026-01-01T15:38:04.000Z',
    })
    assert.equal(canceledRetry.operation.status, 'canceled')
    assert.equal(canceledRetry.operation.nextAttemptAt, undefined)
    assert.equal(
      await repository.claimNext({
        workspaceId,
        leaseOwner: 'worker-integration-retry-after-cancel',
        now: '2026-01-01T15:39:03.000Z',
        leaseUntil: '2026-01-01T15:39:33.000Z',
      }),
      null,
    )

    {
      const cancelRaceOperation = createQueuedPublicOperation({
        ...operation,
        id: 'operation-integration-cancel-race',
        createdAt: '2026-01-01T15:39:10.000Z',
      })
      await repository.createOrReplay({
        operation: cancelRaceOperation,
        context: input.context,
        idempotencyKey: 'operation-cancel-race-request',
        requestFingerprint: sha('3'),
      })
      const [racedClaim, racedCancel] = await Promise.all([
        repository.claimNext({
          workspaceId,
          leaseOwner: 'worker-integration-cancel-race',
          now: '2026-01-01T15:39:11.000Z',
          leaseUntil: '2026-01-01T15:39:41.000Z',
        }),
        repository.cancel({
          workspaceId,
          operationId: cancelRaceOperation.id,
          canceledAt: '2026-01-01T15:39:12.000Z',
        }),
      ])
      assert.equal(racedCancel.operation.status, 'canceled')
      assert.equal(
        (await repository.findById(workspaceId, cancelRaceOperation.id)).operation.status,
        'canceled',
      )
      if (racedClaim) {
        assert.equal(
          await repository.heartbeat({
            operationId: cancelRaceOperation.id,
            leaseOwner: racedClaim.lease.owner,
            attempt: racedClaim.lease.attempt,
            now: '2026-01-01T15:39:13.000Z',
            leaseUntil: '2026-01-01T15:39:43.000Z',
          }),
          false,
        )
      }
    }
    const completedReplay = await repository.cancel({
      workspaceId,
      operationId,
      canceledAt: '2026-01-01T15:40:00.000Z',
    })
    assert.equal(completedReplay.operation.status, 'succeeded')
    assert.equal(completedReplay.operation.completedAt, succeeded.operation.completedAt)
    await assert.rejects(
      repository.retry({
        workspaceId,
        operationId,
        requestedAt: '2026-01-01T15:40:01.000Z',
        nextAttemptAt: '2026-01-01T15:40:01.001Z',
      }),
      (error) =>
        error instanceof DomainError && error.code === 'PUBLIC_OPERATION_RETRY_REJECTED',
    )
    assert.equal(
      await repository.retry({
        workspaceId: 'different-workspace-id',
        operationId: cancelQueuedOperation.id,
        requestedAt: '2026-01-01T15:41:00.000Z',
        nextAttemptAt: '2026-01-01T15:41:00.001Z',
      }),
      null,
    )
    const retriedQueued = await repository.retry({
      workspaceId,
      operationId: cancelQueuedOperation.id,
      requestedAt: '2026-01-01T15:41:00.000Z',
      nextAttemptAt: '2026-01-01T15:41:00.001Z',
    })
    assert.equal(retriedQueued.operation.status, 'queued')
    assert.equal(retriedQueued.operation.attempt, 0)
    assert.equal(retriedQueued.operation.completedAt, undefined)
    const retriedQueuedReplay = await repository.retry({
      workspaceId,
      operationId: cancelQueuedOperation.id,
      requestedAt: '2026-01-01T15:41:00.500Z',
      nextAttemptAt: '2026-01-01T15:41:00.501Z',
    })
    assert.equal(retriedQueuedReplay.operation.updatedAt, retriedQueued.operation.updatedAt)
    const retriedQueuedClaim = await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-retried-queued',
      now: '2026-01-01T15:41:01.000Z',
      leaseUntil: '2026-01-01T15:41:31.000Z',
    })
    assert.equal(retriedQueuedClaim.operation.attempt, 1)
    await repository.cancel({
      workspaceId,
      operationId: cancelQueuedOperation.id,
      canceledAt: '2026-01-01T15:41:02.000Z',
    })

    const retriedRunning = await repository.retry({
      workspaceId,
      operationId: cancelRunningOperation.id,
      requestedAt: '2026-01-01T15:42:00.000Z',
      nextAttemptAt: '2026-01-01T15:42:00.001Z',
    })
    assert.equal(retriedRunning.operation.status, 'retrying')
    assert.equal(retriedRunning.operation.attempt, 1)
    assert.equal(retriedRunning.operation.maxAttempts, 3)
    assert.equal(
      await repository.claimNext({
        workspaceId,
        leaseOwner: 'worker-integration-retry-too-early',
        now: '2026-01-01T15:42:00.000Z',
        leaseUntil: '2026-01-01T15:42:30.000Z',
      }),
      null,
    )
    const retriedRunningClaim = await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-retried-running',
      now: '2026-01-01T15:42:00.001Z',
      leaseUntil: '2026-01-01T15:42:30.001Z',
    })
    assert.equal(retriedRunningClaim.operation.attempt, 2)
    await repository.cancel({
      workspaceId,
      operationId: cancelRunningOperation.id,
      canceledAt: '2026-01-01T15:42:01.000Z',
    })

    const retriedDeadLetter = await repository.retry({
      workspaceId,
      operationId: scheduledOperation.id,
      requestedAt: '2026-01-01T15:43:00.000Z',
      nextAttemptAt: '2026-01-01T15:43:00.001Z',
    })
    assert.equal(retriedDeadLetter.operation.status, 'retrying')
    assert.equal(retriedDeadLetter.operation.attempt, 2)
    assert.equal(retriedDeadLetter.operation.maxAttempts, 3)
    assert.equal(retriedDeadLetter.operation.deadLetteredAt, undefined)
    const retriedDeadLetterClaim = await repository.claimNext({
      workspaceId,
      leaseOwner: 'worker-integration-retried-dead-letter',
      now: '2026-01-01T15:43:00.001Z',
      leaseUntil: '2026-01-01T15:43:30.001Z',
    })
    assert.equal(retriedDeadLetterClaim.operation.attempt, 3)
    await repository.cancel({
      workspaceId,
      operationId: scheduledOperation.id,
      canceledAt: '2026-01-01T15:43:01.000Z',
    })

    {
      const [firstRetry, secondRetry] = await Promise.all([
        repository.retry({
          workspaceId,
          operationId: cancelRetryOperation.id,
          requestedAt: '2026-01-01T15:44:00.000Z',
          nextAttemptAt: '2026-01-01T15:44:00.001Z',
        }),
        repository.retry({
          workspaceId,
          operationId: cancelRetryOperation.id,
          requestedAt: '2026-01-01T15:44:00.000Z',
          nextAttemptAt: '2026-01-01T15:44:00.001Z',
        }),
      ])
      assert.equal(firstRetry.operation.status, 'retrying')
      assert.equal(secondRetry.operation.status, 'retrying')
      assert.equal(firstRetry.operation.maxAttempts, secondRetry.operation.maxAttempts)
      await repository.cancel({
        workspaceId,
        operationId: cancelRetryOperation.id,
        canceledAt: '2026-01-01T15:44:01.000Z',
      })
    }

    for (const suffix of ['a', 'b']) {
      await repository.createOrReplay({
        operation: createQueuedPublicOperation({
          ...operation,
          id: `operation-integration-list-${suffix}`,
          createdAt: '2026-01-01T15:45:00.000Z',
        }),
        context: input.context,
        idempotencyKey: `operation-list-${suffix}-request`,
        requestFingerprint: sha(suffix),
      })
    }
    const firstListPage = await repository.list({
      workspaceId,
      limit: 1,
      status: 'queued',
      type: 'artifact-render',
      targetId: artifactId,
    })
    assert.deepEqual(
      firstListPage.map((record) => record.operation.id),
      ['operation-integration-list-b'],
    )
    const secondListPage = await repository.list({
      workspaceId,
      limit: 2,
      status: 'queued',
      type: 'artifact-render',
      targetId: artifactId,
      after: {
        createdAt: firstListPage[0].operation.createdAt,
        id: firstListPage[0].operation.id,
      },
    })
    assert.deepEqual(
      secondListPage.map((record) => record.operation.id),
      ['operation-integration-list-a'],
    )
    assert.deepEqual(
      await repository.list({ workspaceId: 'different-workspace-id', limit: 10 }),
      [],
    )
    assert.deepEqual(
      await repository.list({ workspaceId, limit: 10, targetId: 'missing-target-id' }),
      [],
    )
    const deadLetterList = await repository.list({
      workspaceId,
      limit: 10,
      status: 'failed',
      deadLettered: true,
      type: 'artifact-render',
      targetId: artifactId,
    })
    assert.deepEqual(
      deadLetterList.map((record) => record.operation.id),
      [exhaustedOperation.id],
    )
    assert.equal(deadLetterList[0].operation.deadLetteredAt, exhausted.operation.deadLetteredAt)
    assert.deepEqual(
      await repository.list({
        workspaceId,
        limit: 10,
        status: 'failed',
        deadLettered: false,
      }),
      [],
    )

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
