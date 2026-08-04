import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error
        ? reject(error)
        : resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-219 persists a server-evidenced closed quality loop through the public API', {
  skip: process.env.APOLLO_QUALITY_ITERATION_E2E !== '1' &&
    'set APOLLO_QUALITY_ITERATION_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )
  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { evaluateRenderedProxy } = await import('../../src/v2/application/render-workflow.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { PrismaProxyReviewRepository } = await import('../../src/v2/infrastructure/prisma/proxy-review-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

  const client = new PrismaClient()
  const rightsRepository = new PrismaAssetRightsRepository(client)
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `quality-workspace-${suffix}`
  const projectId = `quality-project-${suffix}`
  const projectVersionId = `quality-version-${suffix}`
  const selectedArtifactId = `quality-asset-${suffix}`
  const createdAt = new Date('2026-07-26T23:45:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Quality iteration E2E',
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
      id: `quality-client-${suffix}`,
      workspaceId,
      name: 'Quality iteration E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Quality iteration E2E',
        status: 'reviewing-proxy',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    const snapshots = [
      {
        id: `quality-brief-${suffix}`,
        kind: 'brief',
        schemaVersion: 1,
        content: { schemaVersion: 1, objective: 'discovery' },
      },
      {
        id: `quality-edit-plan-${suffix}`,
        kind: 'edit-plan',
        schemaVersion: 2,
        content: {
          schemaVersion: 2,
          id: `quality-plan-${suffix}`,
          state: 'compiled',
          fps: 30,
          durationFrames: 300,
        },
      },
      {
        id: `quality-policies-${suffix}`,
        kind: 'policies',
        schemaVersion: 1,
        content: { schemaVersion: 1, state: 'configured' },
      },
    ]
    for (const snapshot of snapshots) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: snapshot.id,
          workspaceId,
          projectId,
          kind: snapshot.kind,
          schemaVersion: snapshot.schemaVersion,
          contentJson: stableSerialize(snapshot.content),
          contentHash: calculateVersionHash(snapshot.content),
          createdAt,
        },
      })
    }
    const projectVersionHash = calculateVersionHash({ projectId, projectVersionId })
    await client.v2ProjectVersion.create({
      data: {
        id: projectVersionId,
        workspaceId,
        projectId,
        sequence: 1,
        briefSnapshotId: snapshots[0].id,
        editPlanSnapshotId: snapshots[1].id,
        policiesSnapshotId: snapshots[2].id,
        baseHash: projectVersionHash,
        createdBy: issued.client.id,
        createdAt,
      },
    })
    await client.v2Project.update({
      where: { id: projectId },
      data: { currentVersionId: projectVersionId },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: selectedArtifactId,
        workspaceId,
        artifactKey: `quality/${selectedArtifactId}.mp4`,
        sha256: '1'.repeat(64),
        byteSize: 2_000n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    await setAssetRightsService({
      repository: rightsRepository,
      clock: () => createdAt,
      createId: () => `quality-rights-${suffix}`,
    })({
      workspaceId,
      artifactId: selectedArtifactId,
      baseRevision: assetRightsRevision(selectedArtifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: { status: 'not-required', allowedUses: [] },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })

    const proxyRepository = new PrismaProxyReviewRepository(client)
    async function seedProxy(label, criticIssues) {
      const artifactId = `quality-proxy-${label}-${suffix}`
      const manifestId = `quality-proxy-manifest-${label}-${suffix}`
      const operationId = `quality-proxy-operation-${label}-${suffix}`
      const reviewId = `quality-proxy-review-${label}-${suffix}`
      const inputHash = calculateVersionHash({ projectId, projectVersionId, label })
      const proxySha256 = calculateVersionHash({ artifactId })
      await client.v2MediaArtifact.create({
        data: {
          id: artifactId,
          workspaceId,
          artifactKey: `quality/${artifactId}.mp4`,
          sha256: proxySha256,
          byteSize: 2_000n,
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
          createdAt,
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: manifestId,
          workspaceId,
          artifactId,
          schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: calculateVersionHash({ manifestId }),
          recipeId: 'quality-proxy',
          recipeVersion: '1.0.0',
          parametersHash: calculateVersionHash({ manifestId, parameters: true }),
          manifestJson: stableSerialize({
            artifact: { artifactKey: `quality/${artifactId}.mp4` },
            probe: {
              width: 540,
              height: 960,
              duration: 10,
              fps: 30,
              codec: 'h264',
              container: 'mp4',
            },
          }),
          createdAt,
        },
      })
      await client.v2PublicOperation.create({
        data: {
          id: operationId,
          workspaceId,
          projectId,
          clientId: issued.client.id,
          type: 'project-proxy-render',
          status: 'succeeded',
          phase: 'completed',
          targetType: 'media-artifact',
          targetId: artifactId,
          cancelable: false,
          retryable: false,
          attempt: 1,
          maxAttempts: 3,
          resultJson: stableSerialize({
            resource: { type: 'media-artifact', id: artifactId, manifestId },
          }),
          idempotencyKey: `quality-proxy-render-${label}-${suffix}`,
          requestFingerprint: inputHash,
          createdAt,
          updatedAt: createdAt,
          startedAt: createdAt,
          completedAt: new Date(createdAt.getTime() + 1_000),
        },
      })
      await client.v2ProjectProxyRenderOperation.create({
        data: {
          operationId,
          workspaceId,
          projectId,
          projectVersionId,
          editPlanSnapshotId: snapshots[1].id,
          sourceArtifactId: `quality-source-${suffix}`,
          sourceManifestId: `quality-source-manifest-${suffix}`,
          inputHash,
          outputArtifactId: artifactId,
          outputManifestId: manifestId,
          originalFileName: `${artifactId}.mp4`,
          createdAt,
        },
      })
      const review = evaluateRenderedProxy({
        projectVersionId,
        proxyArtifactId: artifactId,
        proxyManifestId: manifestId,
        proxySha256,
        inputHash,
        format: '9:16',
        sourceSha256: calculateVersionHash({ source: suffix }),
        editPlanHash: snapshots[1].contentHash ?? calculateVersionHash(snapshots[1].content),
        expectedDurationMs: 10_000,
        uploadReceivedAt: createdAt.toISOString(),
        renderCompletedAt: new Date(createdAt.getTime() + 1_000).toISOString(),
        probe: {
          width: 540,
          height: 960,
          duration: 10,
          fps: 30,
          codec: 'h264',
          container: 'mp4',
        },
        map: {
          schemaVersion: 'render-element-map/v1',
          mapHash: calculateVersionHash({ map: label }),
          proxyHash: proxySha256,
          fps: 30,
          durationFrames: 300,
          canvas: { width: 540, height: 960 },
          elements: [],
        },
        criticIssues,
      })
      return proxyRepository.persistGenerated({
        id: reviewId,
        workspaceId,
        projectId,
        operationId,
        review,
        createdAt: new Date(createdAt.getTime() + 1_000).toISOString(),
      })
    }

    const readyProxy = await seedProxy('ready', [])
    assert.equal(readyProxy.finalAllowed, true)

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
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`

    const selectionResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/asset-selections`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-selection-${suffix}`,
        },
        body: JSON.stringify({
          projectVersionId,
          projectVersionHash,
          brief: {
            intention: 'Support the claim without hiding the speaker.',
            content: ['dashboard', 'result'],
            style: ['clean'],
            durationMs: { min: 1_000, max: 4_000 },
            entry: 'sentence boundary',
            exit: 'before next claim',
            prohibited: ['fake money'],
          },
          candidates: [{
            artifactId: selectedArtifactId,
            source: 'library',
            content: ['dashboard', 'result'],
            style: ['clean'],
            durationMs: 2_500,
            quality: 0.9,
            continuity: 0.88,
            novelty: 0.5,
            literalness: 0.2,
          }],
        }),
      },
    )
    const selectionPayload = await selectionResponse.json()
    assert.equal(
      selectionResponse.status,
      201,
      `${JSON.stringify(selectionPayload)}\n${serverLogs.slice(-4_000)}`,
    )
    const selection = selectionPayload.data.selection
    const rubricEvidence = [
      'hook-clarity',
      'problem-recognition',
      'trust-building',
      'narrative-integrity',
      'legibility',
      'rights-compliance',
    ].map((criterionId) => ({
      criterionId,
      score: 82,
      evidence: [`Evidence for ${criterionId} is bound to the reviewed proxy.`],
    }))
    const body = {
      projectVersionId,
      projectVersionHash,
      proxyReviewId: readyProxy.id,
      proxyReviewHash: readyProxy.reviewHash,
      expectedProxyReviewRevision: readyProxy.revision,
      assetPlacements: [{
        selectionId: selection.id,
        startMs: 2_000,
        endMs: 3_500,
      }],
      rubricEvidence,
      rangeMetrics: [
        { startMs: 2_000, endMs: 3_500, density: 0.95 },
        { startMs: 7_000, endMs: 7_500, density: 0.96 },
      ],
      datasetId: 'apollo-discovery-reference',
      datasetVersion: 1,
      budgetLimitUnits: 20,
    }
    const createResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-iteration-${suffix}`,
        },
        body: JSON.stringify(body),
      },
    )
    const createPayload = await createResponse.json()
    assert.equal(
      createResponse.status,
      201,
      `${JSON.stringify(createPayload)}\n${serverLogs.slice(-4_000)}`,
    )
    const iteration = createPayload.data.iteration
    assert.equal(createPayload.data.replayed, false)
    assert.equal(iteration.iteration, 1)
    assert.equal(iteration.proxyEvidence.id, readyProxy.id)
    assert.equal(iteration.assetPlacements[0].selectionId, selection.id)
    assert.equal(iteration.assetPlacements[0].rightsApproved, true)
    assert.equal(iteration.assetPlacements[0].novelty, 0.5)
    assert.equal(iteration.validation.finalBlocked, false)
    assert.deepEqual(
      iteration.issues.map((issue) => issue.code),
      ['PATTERN_DENSITY', 'PATTERN_DENSITY'],
    )
    assert.deepEqual(iteration.minimalRerenderRangesMs, [[2_000, 3_500], [7_000, 7_500]])
    assert.equal(iteration.fullRerenderRequired, false)
    assert.equal(iteration.budget.iterationCostUnits, 2)
    assert.equal(iteration.decision.terminalReason, 'approval')
    assert.equal(iteration.dataset.id, 'apollo-discovery-reference')
    assert.equal(iteration.dataset.baselineScore, 68)
    assert.equal(iteration.score, 82)
    assert.equal(iteration.regression, 14)
    assert.match(iteration.reportFingerprint, /^[a-f0-9]{64}$/)
    assert.match(iteration.recordHash, /^[a-f0-9]{64}$/)

    const replayResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-iteration-${suffix}`,
        },
        body: JSON.stringify(body),
      },
    )
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.iteration.id, iteration.id)

    const mismatchResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-iteration-${suffix}`,
        },
        body: JSON.stringify({
          ...body,
          rangeMetrics: [{ startMs: 2_000, endMs: 3_500, density: 0.5 }],
        }),
      },
    )
    assert.equal(mismatchResponse.status, 409, JSON.stringify(await mismatchResponse.json()))

    const staleResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-stale-${suffix}`,
        },
        body: JSON.stringify({ ...body, projectVersionHash: '0'.repeat(64) }),
      },
    )
    assert.equal(staleResponse.status, 409, JSON.stringify(await staleResponse.json()))

    const injectedApprovalResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-injection-${suffix}`,
        },
        body: JSON.stringify({
          ...body,
          approved: true,
          issues: [],
          rightsApproved: true,
        }),
      },
    )
    assert.equal(
      injectedApprovalResponse.status,
      422,
      JSON.stringify(await injectedApprovalResponse.json()),
    )

    const wrongDatasetResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-dataset-${suffix}`,
        },
        body: JSON.stringify({ ...body, datasetId: 'client-invented-baseline' }),
      },
    )
    assert.equal(
      wrongDatasetResponse.status,
      428,
      JSON.stringify(await wrongDatasetResponse.json()),
    )

    const warningProxy = await seedProxy('warning', [{
      code: 'EDITORIAL_PACING_WARNING',
      severity: 'warning',
      category: 'editorial',
      message: 'Pacing still requires one bounded adjustment.',
      rangeMs: [4_000, 5_000],
      targetId: 'scene-1',
      correctable: true,
    }])
    assert.equal(warningProxy.finalAllowed, false)
    const convergenceResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-convergence-${suffix}`,
        },
        body: JSON.stringify({
          ...body,
          proxyReviewId: warningProxy.id,
          proxyReviewHash: warningProxy.reviewHash,
          expectedProxyReviewRevision: warningProxy.revision,
        }),
      },
    )
    const convergencePayload = await convergenceResponse.json()
    assert.equal(
      convergenceResponse.status,
      201,
      `${JSON.stringify(convergencePayload)}\n${serverLogs.slice(-4_000)}`,
    )
    assert.equal(convergencePayload.data.iteration.iteration, 2)
    assert.equal(convergencePayload.data.iteration.previousIterationId, iteration.id)
    assert.equal(convergencePayload.data.iteration.decision.terminalReason, 'convergence')

    const revokedProxy = await seedProxy('revoked', [])
    await setAssetRightsService({
      repository: rightsRepository,
      clock: () => new Date(createdAt.getTime() + 2_000),
      createId: () => `quality-rights-revoked-${suffix}`,
    })({
      workspaceId,
      artifactId: selectedArtifactId,
      baseRevision: assetRightsRevision(selectedArtifactId, 1),
      draft: {
        status: 'revoked',
        allowedUses: [],
        prohibitedUses: [],
        consent: { status: 'not-required', allowedUses: [] },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })
    const revokedRightsResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `quality-revoked-rights-${suffix}`,
        },
        body: JSON.stringify({
          ...body,
          proxyReviewId: revokedProxy.id,
          proxyReviewHash: revokedProxy.reviewHash,
          expectedProxyReviewRevision: revokedProxy.revision,
        }),
      },
    )
    const revokedRightsPayload = await revokedRightsResponse.json()
    assert.equal(
      revokedRightsResponse.status,
      201,
      `${JSON.stringify(revokedRightsPayload)}\n${serverLogs.slice(-4_000)}`,
    )
    assert.equal(revokedRightsPayload.data.iteration.iteration, 3)
    assert.equal(
      revokedRightsPayload.data.iteration.assetPlacements[0].rightsApproved,
      false,
    )
    assert.ok(
      revokedRightsPayload.data.iteration.issues.some(
        (issue) => issue.code === 'ASSET_RIGHTS' && issue.severity === 'hard',
      ),
    )
    assert.equal(
      revokedRightsPayload.data.iteration.decision.terminalReason,
      'uncorrectable',
    )

    const listResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations?projectVersionId=${projectVersionId}&limit=10`,
      { headers: { authorization } },
    )
    const listPayload = await listResponse.json()
    assert.equal(listResponse.status, 200, JSON.stringify(listPayload))
    assert.equal(listPayload.data.iterations.length, 3)
    assert.deepEqual(
      listPayload.data.iterations.map((item) => item.iteration),
      [3, 2, 1],
    )

    const stored = await client.v2QualityIteration.findUnique({
      where: { id: iteration.id },
    })
    assert.ok(stored)
    await client.v2QualityIteration.update({
      where: { id: iteration.id },
      data: { recordHash: '0'.repeat(64) },
    })
    const corruptedResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/quality-iterations?limit=10`,
      { headers: { authorization } },
    )
    assert.equal(corruptedResponse.status, 409, JSON.stringify(await corruptedResponse.json()))
    await client.v2QualityIteration.update({
      where: { id: iteration.id },
      data: { recordHash: stored.recordHash },
    })
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE').catch(() => {})
    await client.$disconnect()
  }
})
