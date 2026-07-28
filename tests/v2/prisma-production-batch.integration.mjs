import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import test from 'node:test'

import {
  Prisma,
  PrismaClient,
} from '../../generated/prisma-v2/index.js'

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address
        ? address.port
        : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next server exited with ${server.exitCode}`)
    }
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for Next server')
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

test('T-FR-080 / T-FR-086 persists production batches and signed batch edits through the public API', {
  skip:
    process.env.APOLLO_PRODUCTION_BATCH_E2E !== '1' &&
    'set APOLLO_PRODUCTION_BATCH_E2E=1 and use an isolated V2 database',
  timeout: 240_000,
}, async () => {
  assert.ok(
    process.env.V2_DATABASE_URL,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const databaseName = new URL(process.env.V2_DATABASE_URL)
    .pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )

  const { assetRightsRevision } =
    await import('../../src/v2/domain/asset-rights.ts')
  const { createApiClientService } =
    await import('../../src/v2/application/create-api-client.ts')
  const { setAssetRightsService } =
    await import('../../src/v2/application/set-asset-rights.ts')
  const { PrismaApiClientRepository } =
    await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
  const { PrismaAssetRightsRepository } =
    await import(
      '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
    )
  const { nodeApiCredentialCrypto } =
    await import(
      '../../src/v2/infrastructure/security/api-credential.ts'
    )

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `batch-e2e-workspace-${suffix}`
  const projectId = `batch-e2e-project-${suffix}`
  const sourceHookId = `batch-e2e-source-hook-${suffix}`
  const sourceBodyId = `batch-e2e-source-body-${suffix}`
  const finalOneId = `batch-e2e-final-one-${suffix}`
  const planTwoId = `batch-e2e-plan-two-${suffix}`
  const createdAt = new Date('2026-07-27T20:30:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe(
      'TRUNCATE TABLE "workspaces" CASCADE',
    )
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Production batch E2E',
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `batch-e2e-client-${suffix}`,
      workspaceId,
      name: 'Production batch E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Campanha de descoberta',
        status: 'draft',
        objective: 'content-distribution',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    const artifactIds = [
      sourceHookId,
      sourceBodyId,
      finalOneId,
      planTwoId,
    ]
    await client.v2MediaArtifact.createMany({
      data: artifactIds.map((id, index) => ({
        id,
        workspaceId,
        artifactKey: `workspaces/${workspaceId}/batch/${id}.mp4`,
        sha256: String(index + 1).repeat(64),
        byteSize: BigInt(10_000 + index),
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      })),
    })
    await client.v2MediaArtifactManifest.createMany({
      data: [sourceHookId, sourceBodyId].map((artifactId, index) => ({
        id: `batch-e2e-manifest-${index}-${suffix}`,
        workspaceId,
        artifactId,
        schemaVersion: 'media-artifact-manifest/v1',
        manifestHash: String(index + 5).repeat(64),
        recipeId: 'source-upload',
        recipeVersion: '1',
        parametersHash: String(index + 7).repeat(64),
        manifestJson: JSON.stringify({
          probe: {
            width: 1080,
            height: 1920,
            duration: index === 0 ? 18 : 42,
            fps: 30,
          },
        }),
        createdAt,
      })),
    })
    await client.v2ProjectMediaAsset.createMany({
      data: [sourceHookId, sourceBodyId].map((artifactId, index) => ({
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId,
        role: 'source-master',
        originalFileName:
          index === 0
            ? 'hooks-validados.mp4'
            : 'corpos-e-ctas.mp4',
        createdAt,
      })),
    })
    for (const [index, artifactId] of [
      sourceHookId,
      sourceBodyId,
    ].entries()) {
      await setAssetRightsService({
        repository: new PrismaAssetRightsRepository(client),
        clock: () => createdAt,
        createId: () =>
          `batch-e2e-rights-${index}-${suffix}`,
      })({
        workspaceId,
        artifactId,
        baseRevision: assetRightsRevision(artifactId, 0),
        draft: {
          status: 'approved',
          allowedUses: ['paid-ad', 'editorial-reuse'],
          prohibitedUses: [],
          allowedLocales: ['pt-BR'],
          consent: {
            status: 'not-required',
            allowedUses: [],
          },
        },
        actor: { type: 'api-client', id: issued.client.id },
      })
    }

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-p', String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production',
          APOLLO_PREFLIGHT_COMMIT_TOKEN_SECRET:
            'batch-edit-e2e-signed-commit-secret-32-bytes',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    server.stdout.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    server.stderr.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    await waitForServer(baseUrl, server)

    const endpoint = `${baseUrl}/v1/batches`
    const authorization = `Bearer ${issued.token}`
    const headers = {
      authorization,
      'content-type': 'application/json',
    }
    const body = {
      projectId,
      name: 'Campanha de descoberta',
      objective: 'content-distribution',
      sourceGroups: [
        {
          id: 'source-group-hooks',
          name: 'Hooks validados',
          sourceArtifactIds: [sourceHookId],
        },
        {
          id: 'source-group-body',
          name: 'Corpo e CTA',
          sourceArtifactIds: [sourceBodyId],
        },
      ],
      recipes: [
        {
          id: 'recipe-hook',
          name: 'Hook direto',
          sourceGroupIds: ['source-group-hooks'],
        },
        {
          id: 'recipe-body',
          name: 'Argumento completo',
          sourceGroupIds: ['source-group-body'],
        },
      ],
      variants: [
        {
          id: 'variant-vertical',
          name: 'Vertical',
          outputSpecId: '9:16',
          locale: 'pt-BR',
        },
        {
          id: 'variant-square',
          name: 'Quadrado',
          outputSpecId: '1:1',
          locale: 'pt-BR',
        },
      ],
      budget: {
        currency: 'USD',
        maxCostMinorUnits: 10_000,
        reservedCostMinorUnits: 3_000,
      },
      items: [
        {
          key: 'hook/vertical',
          sourceGroupId: 'source-group-hooks',
          recipeId: 'recipe-hook',
          variantId: 'variant-vertical',
        },
        {
          key: 'hook/square',
          sourceGroupId: 'source-group-hooks',
          recipeId: 'recipe-hook',
          variantId: 'variant-square',
        },
        {
          key: 'body/vertical',
          sourceGroupId: 'source-group-body',
          recipeId: 'recipe-body',
          variantId: 'variant-vertical',
        },
      ],
    }

    const unauthenticated = await fetch(endpoint)
    assert.equal(unauthenticated.status, 401)

    const createKey = `batch-create-${suffix}`
    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify(body),
    })
    const createPayload = await createResponse.json()
    assert.equal(
      createResponse.status,
      201,
      JSON.stringify(createPayload),
    )
    assert.equal(createPayload.data.replayed, false)
    let batch = createPayload.data.batch
    assert.equal(batch.status, 'queued')
    assert.equal(batch.items.length, 3)
    assert.equal(batch.progress.totalSteps, 12)
    assert.equal(batch.progress.percent, 0)

    const replayResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify(body),
    })
    assert.equal(replayResponse.status, 200)
    assert.equal((await replayResponse.json()).data.replayed, true)

    const mismatchResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': createKey,
      },
      body: JSON.stringify({ ...body, name: 'Other batch' }),
    })
    assert.equal(mismatchResponse.status, 409)

    const listResponse = await fetch(
      `${endpoint}?projectId=${projectId}&status=queued&q=descoberta`,
      { headers: { authorization } },
    )
    const listPayload = await listResponse.json()
    assert.equal(listResponse.status, 200)
    assert.equal(listPayload.data.batches.length, 1)
    assert.equal(listPayload.data.batches[0].id, batch.id)

    const action = async (
      itemId,
      actionBody,
      idempotencyKey,
    ) => {
      const response = await fetch(
        `${endpoint}/${batch.id}/items/${itemId}/actions`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(actionBody),
        },
      )
      const payload = await response.json()
      assert.ok(
        [200, 201].includes(response.status),
        JSON.stringify(payload),
      )
      return { response, payload }
    }

    const firstItemId = batch.items[0].id
    const firstStart = await action(firstItemId, {
      action: 'start-step',
      step: 'planning',
      expectedBatchRevision: batch.revision,
      expectedItemRevision: batch.items[0].revision,
    }, `batch-first-start-${suffix}`)
    batch = firstStart.payload.data.batch
    const firstStartReplay = await action(firstItemId, {
      action: 'start-step',
      step: 'planning',
      expectedBatchRevision: 1,
      expectedItemRevision: 1,
    }, `batch-first-start-${suffix}`)
    assert.equal(firstStartReplay.response.status, 200)
    assert.equal(firstStartReplay.payload.data.replayed, true)
    assert.equal(
      firstStartReplay.payload.data.batch.revision,
      batch.revision,
    )

    const completeStep = async (
      itemId,
      step,
      costMinorUnits,
      artifactIds,
    ) => {
      const item = batch.items.find((candidate) =>
        candidate.id === itemId)
      const started = await action(itemId, {
        action: 'start-step',
        step,
        expectedBatchRevision: batch.revision,
        expectedItemRevision: item.revision,
      }, `batch-${itemId}-${step}-start-${suffix}`)
      batch = started.payload.data.batch
      const running = batch.items.find((candidate) =>
        candidate.id === itemId)
      const completed = await action(itemId, {
        action: 'complete-step',
        step,
        expectedBatchRevision: batch.revision,
        expectedItemRevision: running.revision,
        costMinorUnits,
        cacheHit: false,
        ...(artifactIds ? { artifactIds } : {}),
      }, `batch-${itemId}-${step}-complete-${suffix}`)
      batch = completed.payload.data.batch
    }

    {
      const running = batch.items.find((item) => item.id === firstItemId)
      const completed = await action(firstItemId, {
        action: 'complete-step',
        step: 'planning',
        expectedBatchRevision: batch.revision,
        expectedItemRevision: running.revision,
        costMinorUnits: 1,
        cacheHit: false,
      }, `batch-first-planning-complete-${suffix}`)
      batch = completed.payload.data.batch
    }
    await completeStep(firstItemId, 'materializing', 1)
    await completeStep(firstItemId, 'rendering', 1)
    await completeStep(firstItemId, 'reviewing', 1, [finalOneId])

    const secondItemId = batch.items[1].id
    await completeStep(secondItemId, 'planning', 2, [planTwoId])
    {
      const item = batch.items.find((candidate) =>
        candidate.id === secondItemId)
      const started = await action(secondItemId, {
        action: 'start-step',
        step: 'materializing',
        expectedBatchRevision: batch.revision,
        expectedItemRevision: item.revision,
      }, `batch-second-materializing-start-${suffix}`)
      batch = started.payload.data.batch
      const running = batch.items.find((candidate) =>
        candidate.id === secondItemId)
      const failed = await action(secondItemId, {
        action: 'fail-step',
        step: 'materializing',
        expectedBatchRevision: batch.revision,
        expectedItemRevision: running.revision,
        costMinorUnits: 3,
        cacheHit: false,
        error: {
          code: 'PROVIDER_TIMEOUT',
          message: 'Provider timed out during the bounded attempt.',
        },
      }, `batch-second-materializing-fail-${suffix}`)
      batch = failed.payload.data.batch
    }

    const thirdItemId = batch.items[2].id
    {
      const item = batch.items.find((candidate) =>
        candidate.id === thirdItemId)
      const cancelled = await action(thirdItemId, {
        action: 'cancel',
        expectedBatchRevision: batch.revision,
        expectedItemRevision: item.revision,
      }, `batch-third-cancel-${suffix}`)
      batch = cancelled.payload.data.batch
    }
    assert.equal(batch.status, 'partially-completed')
    assert.equal(batch.progress.completedSteps, 5)
    assert.equal(batch.progress.failedSteps, 1)
    assert.equal(batch.progress.cancelledSteps, 4)
    assert.equal(batch.progress.percent, 41)
    assert.equal(batch.progress.spentMinorUnits, 9)
    assert.deepEqual(batch.items[0].artifactIds, [finalOneId])
    assert.deepEqual(batch.items[1].artifactIds, [planTwoId])

    const partialListResponse = await fetch(
      `${endpoint}?status=partially-completed`,
      { headers: { authorization } },
    )
    assert.equal(partialListResponse.status, 200)
    assert.equal(
      (await partialListResponse.json()).data.batches.length,
      1,
    )

    {
      const failed = batch.items.find((candidate) =>
        candidate.id === secondItemId)
      const retried = await action(secondItemId, {
        action: 'retry-step',
        step: 'materializing',
        expectedBatchRevision: batch.revision,
        expectedItemRevision: failed.revision,
      }, `batch-second-materializing-retry-${suffix}`)
      batch = retried.payload.data.batch
      assert.deepEqual(
        batch.items.find((item) => item.id === secondItemId).artifactIds,
        [planTwoId],
      )
      assert.equal(batch.progress.spentMinorUnits, 9)
    }
    {
      const queued = batch.items.find((candidate) =>
        candidate.id === secondItemId)
      const started = await action(secondItemId, {
        action: 'start-step',
        step: 'materializing',
        expectedBatchRevision: batch.revision,
        expectedItemRevision: queued.revision,
      }, `batch-second-materializing-restart-${suffix}`)
      batch = started.payload.data.batch
      const running = batch.items.find((candidate) =>
        candidate.id === secondItemId)
      const completed = await action(secondItemId, {
        action: 'complete-step',
        step: 'materializing',
        expectedBatchRevision: batch.revision,
        expectedItemRevision: running.revision,
        costMinorUnits: 999,
        cacheHit: true,
      }, `batch-second-materializing-cache-${suffix}`)
      batch = completed.payload.data.batch
      assert.equal(batch.progress.spentMinorUnits, 9)
      assert.equal(
        batch.items.find((item) => item.id === secondItemId)
          .steps[1].attempt,
        2,
      )
    }

    const stale = await fetch(
      `${endpoint}/${batch.id}/items/${secondItemId}/actions`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `batch-stale-${suffix}`,
        },
        body: JSON.stringify({
          action: 'start-step',
          step: 'rendering',
          expectedBatchRevision: 1,
          expectedItemRevision: 1,
        }),
      },
    )
    assert.equal(stale.status, 409)

    const batchAction = async (actionName) => {
      const response = await fetch(
        `${endpoint}/${batch.id}/actions`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'idempotency-key':
              `batch-${actionName}-${batch.revision}-${suffix}`,
          },
          body: JSON.stringify({
            action: actionName,
            expectedBatchRevision: batch.revision,
          }),
        },
      )
      const payload = await response.json()
      assert.equal(response.status, 201, JSON.stringify(payload))
      batch = payload.data.batch
    }
    await batchAction('cancel')
    assert.equal(batch.items[0].state, 'completed')
    assert.equal(batch.items[1].state, 'cancelled')
    assert.equal(batch.items[2].state, 'cancelled')
    assert.deepEqual(batch.items[0].artifactIds, [finalOneId])
    await batchAction('resume')
    assert.equal(batch.items[0].state, 'completed')
    assert.equal(batch.items[1].state, 'queued')
    assert.equal(batch.items[2].state, 'queued')
    assert.deepEqual(batch.items[1].artifactIds, [planTwoId])
    assert.equal(batch.progress.spentMinorUnits, 9)

    const readResponse = await fetch(`${endpoint}/${batch.id}`, {
      headers: { authorization },
    })
    const readPayload = await readResponse.json()
    assert.equal(readResponse.status, 200)
    assert.equal(readPayload.data.batch.revision, batch.revision)
    assert.equal(readPayload.data.batch.progress.spentMinorUnits, 9)
    assert.deepEqual(
      readPayload.data.batch.items[0].artifactIds,
      [finalOneId],
    )

    const { createBatchEditItemState } =
      await import('../../src/v2/domain/batch-edit.ts')
    const { stableSerialize } =
      await import('../../src/v2/domain/canonical-hash.ts')
    const protectedCtaState = createBatchEditItemState({
      workspaceId,
      batchId: batch.id,
      itemId: secondItemId,
      protectedOperations: ['replace-cta'],
      createdByClientId: issued.client.id,
      createdAt: '2026-07-28T20:31:00.000Z',
    })
    await client.v2BatchEditItemStateVersion.create({
      data: {
        workspaceId,
        batchId: batch.id,
        itemId: secondItemId,
        revision: protectedCtaState.revision,
        schemaVersion: protectedCtaState.schemaVersion,
        directivesJson: stableSerialize(protectedCtaState.directives),
        protectedOperationsJson: stableSerialize(
          protectedCtaState.protectedOperations,
        ),
        stateJson: stableSerialize(protectedCtaState),
        stateHash: protectedCtaState.stateHash,
        previousStateHash: null,
        sourceCommandId: null,
        createdByClientId: issued.client.id,
        createdAt: new Date(protectedCtaState.createdAt),
      },
    })

    const editScope = {
      expectedBatchRevision: batch.revision,
      expectedBatchDefinitionHash: batch.definitionHash,
      recipeIds: ['recipe-hook', 'recipe-body'],
      outputSpecIds: ['9:16', '1:1'],
      itemIds: batch.items.map((item) => item.id),
    }
    const editPreflightEndpoint =
      `${endpoint}/${batch.id}/edit-preflights`
    const createEditPreflight = async ({
      key,
      operation,
      mode,
      expectedStatus,
    }) => {
      const response = await fetch(editPreflightEndpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': key,
        },
        body: JSON.stringify({
          ...editScope,
          operation,
          mode,
        }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201, JSON.stringify(payload))
      assert.equal(payload.data.preflight.status, expectedStatus)
      return payload.data
    }
    const commitEditPreflight = async ({
      key,
      preflight,
      commitToken,
      expectedStatus,
      expectedApplied,
      expectedSkipped,
    }) => {
      const response = await fetch(
        `${editPreflightEndpoint}/${preflight.id}/commit`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'idempotency-key': key,
          },
          body: JSON.stringify({
            expectedPreflightHash: preflight.preflightHash,
            expectedScopeHash: preflight.scope.scopeHash,
            commitToken,
          }),
        },
      )
      const payload = await response.json()
      assert.equal(response.status, 201, JSON.stringify(payload))
      assert.equal(payload.data.command.status, expectedStatus)
      assert.equal(
        payload.data.command.appliedItemCount,
        expectedApplied,
      )
      assert.equal(
        payload.data.command.skippedItemCount,
        expectedSkipped,
      )
      return payload.data
    }

    const atomicCta = await createEditPreflight({
      key: `batch-edit-cta-atomic-${suffix}`,
      operation: {
        type: 'replace-cta',
        valueRef: 'cta-validated-v2',
      },
      mode: 'all-or-nothing',
      expectedStatus: 'blocked',
    })
    assert.equal(atomicCta.preflight.protectedConflictCount, 1)
    assert.equal(atomicCta.commitToken, undefined)
    assert.equal(atomicCta.preflight.confirmationExpiresAt, undefined)

    const partialCta = await createEditPreflight({
      key: `batch-edit-cta-partial-${suffix}`,
      operation: {
        type: 'replace-cta',
        valueRef: 'cta-validated-v2',
      },
      mode: 'skip-failures',
      expectedStatus: 'partial-ready',
    })
    assert.ok(partialCta.commitToken)
    assert.equal(partialCta.preflight.applicableItemCount, 2)
    assert.equal(partialCta.preflight.invalidationCount, 8)
    const ctaCommit = await commitEditPreflight({
      key: `batch-edit-cta-commit-${suffix}`,
      preflight: partialCta.preflight,
      commitToken: partialCta.commitToken,
      expectedStatus: 'partial',
      expectedApplied: 2,
      expectedSkipped: 1,
    })
    assert.equal(ctaCommit.command.costMinorUnits, 250)
    assert.equal(ctaCommit.command.resultItems.length, 3)

    const ctaCommitReplayResponse = await fetch(
      `${editPreflightEndpoint}/${partialCta.preflight.id}/commit`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `batch-edit-cta-commit-${suffix}`,
        },
        body: JSON.stringify({
          expectedPreflightHash: partialCta.preflight.preflightHash,
          expectedScopeHash: partialCta.preflight.scope.scopeHash,
          commitToken: partialCta.commitToken,
        }),
      },
    )
    const ctaCommitReplayPayload =
      await ctaCommitReplayResponse.json()
    assert.equal(ctaCommitReplayResponse.status, 200)
    assert.equal(ctaCommitReplayPayload.data.replayed, true)
    assert.equal(
      ctaCommitReplayPayload.data.command.commandHash,
      ctaCommit.command.commandHash,
    )

    const subtitlePreview = await createEditPreflight({
      key: `batch-edit-subtitle-${suffix}`,
      operation: {
        type: 'subtitle-style',
        valueRef: 'subtitle-editorial-v3',
      },
      mode: 'all-or-nothing',
      expectedStatus: 'ready',
    })
    assert.equal(subtitlePreview.preflight.invalidationCount, 6)
    assert.equal(subtitlePreview.preflight.sampleDiff.length, 3)
    const subtitleCommit = await commitEditPreflight({
      key: `batch-edit-subtitle-commit-${suffix}`,
      preflight: subtitlePreview.preflight,
      commitToken: subtitlePreview.commitToken,
      expectedStatus: 'committed',
      expectedApplied: 3,
      expectedSkipped: 0,
    })
    assert.equal(subtitleCommit.command.costMinorUnits, 75)

    const brandPreview = await createEditPreflight({
      key: `batch-edit-brand-${suffix}`,
      operation: {
        type: 'brand-kit',
        valueRef: 'brand-kit-snapshot-v7',
      },
      mode: 'all-or-nothing',
      expectedStatus: 'ready',
    })
    assert.equal(brandPreview.preflight.invalidationCount, 9)
    const brandCommit = await commitEditPreflight({
      key: `batch-edit-brand-commit-${suffix}`,
      preflight: brandPreview.preflight,
      commitToken: brandPreview.commitToken,
      expectedStatus: 'committed',
      expectedApplied: 3,
      expectedSkipped: 0,
    })
    assert.equal(brandCommit.command.costMinorUnits, 225)

    const preflightListResponse = await fetch(
      `${editPreflightEndpoint}?limit=100`,
      { headers: { authorization } },
    )
    const preflightListPayload = await preflightListResponse.json()
    assert.equal(preflightListResponse.status, 200)
    assert.equal(preflightListPayload.data.preflights.length, 4)
    const commandListResponse = await fetch(
      `${endpoint}/${batch.id}/edit-commands?limit=100`,
      { headers: { authorization } },
    )
    const commandListPayload = await commandListResponse.json()
    assert.equal(commandListResponse.status, 200)
    assert.equal(commandListPayload.data.commands.length, 3)

    const readEditPreflightResponse = await fetch(
      `${editPreflightEndpoint}/${brandPreview.preflight.id}`,
      { headers: { authorization } },
    )
    assert.equal(readEditPreflightResponse.status, 200)
    assert.equal(
      (await readEditPreflightResponse.json()).data.preflight
        .preflightHash,
      brandPreview.preflight.preflightHash,
    )
    const readEditCommandResponse = await fetch(
      `${endpoint}/${batch.id}/edit-commands/${brandCommit.command.id}`,
      { headers: { authorization } },
    )
    assert.equal(readEditCommandResponse.status, 200)
    assert.equal(
      (await readEditCommandResponse.json()).data.command.commandHash,
      brandCommit.command.commandHash,
    )

    const unauthenticatedEdit = await fetch(editPreflightEndpoint)
    assert.equal(unauthenticatedEdit.status, 401)
    const staleScopeCommit = await fetch(
      `${editPreflightEndpoint}/${brandPreview.preflight.id}/commit`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `batch-edit-stale-scope-${suffix}`,
        },
        body: JSON.stringify({
          expectedPreflightHash: brandPreview.preflight.preflightHash,
          expectedScopeHash: 'f'.repeat(64),
          commitToken: brandPreview.commitToken,
        }),
      },
    )
    assert.equal(staleScopeCommit.status, 409)

    assert.equal(
      await client.v2ProductionBatch.count({
        where: { workspaceId },
      }),
      1,
    )
    assert.equal(
      await client.v2ProductionBatchItem.count({
        where: { workspaceId },
      }),
      3,
    )
    assert.equal(
      await client.v2ProductionBatchStep.count({
        where: { workspaceId },
      }),
      12,
    )
    assert.equal(
      await client.v2ProductionBatchItemArtifact.count({
        where: { workspaceId },
      }),
      2,
    )
    assert.ok(
      await client.v2ProductionBatchAction.count({
        where: { workspaceId },
      }) >= 16,
    )
    assert.equal(
      await client.v2BatchEditPreflightRun.count({
        where: { workspaceId },
      }),
      4,
    )
    assert.equal(
      await client.v2BatchEditCommand.count({
        where: { workspaceId },
      }),
      3,
    )
    assert.equal(
      await client.v2BatchEditCommandItem.count({
        where: { workspaceId },
      }),
      9,
    )
    assert.equal(
      await client.v2BatchEditInvalidation.count({
        where: { workspaceId },
      }),
      23,
    )
    assert.equal(
      await client.v2BatchEditItemStateVersion.count({
        where: { workspaceId },
      }),
      11,
    )

    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "production_batch_steps"
          SET "state" = 'failed',
              "errorCode" = NULL,
              "errorMessage" = NULL
          WHERE "workspaceId" = ${workspaceId}
            AND "itemId" = ${firstItemId}
            AND "step" = 'planning'
        `,
      ),
    )

    const invalidationToTamper =
      await client.v2BatchEditInvalidation.findFirstOrThrow({
        where: { commandId: brandCommit.command.id },
        orderBy: [{ itemId: 'asc' }, { sequence: 'asc' }],
      })
    await client.v2BatchEditInvalidation.updateMany({
      where: {
        commandId: invalidationToTamper.commandId,
        itemId: invalidationToTamper.itemId,
        step: invalidationToTamper.step,
      },
      data: {
        targetRef: `${invalidationToTamper.targetRef}:tampered`,
        invalidationHash: 'f'.repeat(64),
      },
    })
    const tamperedCommandRead = await fetch(
      `${endpoint}/${batch.id}/edit-commands/${brandCommit.command.id}`,
      { headers: { authorization } },
    )
    const tamperedCommandPayload = await tamperedCommandRead.json()
    assert.equal(tamperedCommandRead.status, 409)
    assert.equal(
      tamperedCommandPayload.error.code,
      'PERSISTENCE_CONFLICT',
    )
    await client.v2BatchEditInvalidation.updateMany({
      where: {
        commandId: invalidationToTamper.commandId,
        itemId: invalidationToTamper.itemId,
        step: invalidationToTamper.step,
      },
      data: {
        targetRef: invalidationToTamper.targetRef,
        invalidationHash: invalidationToTamper.invalidationHash,
      },
    })
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "production_batches"
          SET "aggregateStatus" = 'fabricated'
          WHERE "workspaceId" = ${workspaceId}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "batch_edit_commands"
          SET "appliedItemCount" = 999
          WHERE "id" = ${brandCommit.command.id}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "batch_edit_command_items"
          SET "afterStateHash" = NULL
          WHERE "commandId" = ${brandCommit.command.id}
            AND "status" = 'applied'
        `,
      ),
    )
  } catch (error) {
    if (serverLogs) {
      error.message += `\nNext logs:\n${serverLogs.slice(-8_000)}`
    }
    throw error
  } finally {
    await stopServer(server)
    await client.$disconnect()
  }
})
