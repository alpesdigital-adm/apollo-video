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

function tierVersions(visionVersion = '1.0.0') {
  return {
    'cheap-signals': {
      provider: 'apollo',
      model: 'transcript-statistics',
      version: '1.0.0',
    },
    vision: {
      provider: 'apollo',
      model: 'cataloged-visual-observations',
      version: visionVersion,
    },
    language: {
      provider: 'apollo',
      model: 'transcript-segmentation',
      version: '1.0.0',
    },
    aggregation: {
      provider: 'apollo',
      model: 'evidence-preserving-aggregation',
      version: '1.0.0',
    },
  }
}

test('T-FR-053 executes, persists and partially reuses hierarchical two-hour processing through the public API', {
  skip:
    process.env.APOLLO_HIERARCHICAL_E2E !== '1' &&
    'set APOLLO_HIERARCHICAL_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
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
  const {
    createMediaArtifactManifest,
    createMediaArtifactManifestV2,
  } =
    await import('../../src/v2/domain/media-artifact.ts')
  const { createMediaTranscript } =
    await import('../../src/v2/domain/media-transcript.ts')
  const { stableSerialize } =
    await import('../../src/v2/domain/canonical-hash.ts')
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
  const workspaceId = `hierarchical-e2e-workspace-${suffix}`
  const projectId = `hierarchical-e2e-project-${suffix}`
  const artifactId = `hierarchical-e2e-artifact-${suffix}`
  const manifestId = `hierarchical-e2e-manifest-${suffix}`
  const transcriptManifestId =
    `hierarchical-e2e-transcript-manifest-${suffix}`
  const transcriptId = `hierarchical-e2e-transcript-${suffix}`
  const createdAt = new Date('2026-07-27T18:30:00.000Z')
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
        name: 'Hierarchical processing E2E',
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
      id: `hierarchical-e2e-client-${suffix}`,
      workspaceId,
      name: 'Hierarchical processing E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Live de duas horas',
        status: 'draft',
        objective: 'discovery',
        format: '16:9',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    const artifactSha256 = 'a'.repeat(64)
    const artifactKey =
      `workspaces/${workspaceId}/masters/${artifactId}.mp4`
    const manifest = createMediaArtifactManifestV2({
      artifactKey,
      artifactSha256,
      byteSize: 20_000_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'hierarchical-e2e-master',
        version: '1.0.0',
        parameters: { fixture: 'two-hour-live' },
      },
      sources: [],
      probe: {
        width: 1920,
        height: 1080,
        duration: 7_200,
        fps: 30,
      },
    })
    const transcriptManifest = createMediaArtifactManifest({
      artifactKey,
      artifactSha256,
      byteSize: 20_000_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'hierarchical-e2e-upload',
        version: '1.0.0',
        parameters: { fixture: 'source-upload' },
      },
      sources: [],
    })
    const segments = Array.from({ length: 24 }, (_, id) => ({
      id,
      start: id * 300 + 10,
      end: id * 300 + 30,
      text:
        `Reflexao completa ${id} sobre aquisicao, prova e oferta.`,
      confidence: 0.98,
    }))
    const transcript = createMediaTranscript({
      language: 'pt-BR',
      text: segments.map((segment) => segment.text).join(' '),
      words: segments.flatMap((segment) => {
        const words = segment.text.split(' ')
        return words.map((word, index) => ({
          word,
          start: segment.start + index,
          end: segment.start + index + 0.5,
        }))
      }),
      segments,
      provider: 'apollo',
      model: 'hierarchical-e2e-transcript',
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey,
        sha256: artifactSha256,
        byteSize: BigInt(20_000_000),
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
        schemaVersion: manifest.schemaVersion,
        manifestHash: manifest.manifestHash,
        recipeId: manifest.recipe.id,
        recipeVersion: manifest.recipe.version,
        parametersHash: manifest.recipe.parametersHash,
        manifestJson: stableSerialize(manifest),
        createdAt,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: transcriptManifestId,
        workspaceId,
        artifactId,
        schemaVersion: transcriptManifest.schemaVersion,
        manifestHash: transcriptManifest.manifestHash,
        recipeId: transcriptManifest.recipe.id,
        recipeVersion: transcriptManifest.recipe.version,
        parametersHash: transcriptManifest.recipe.parametersHash,
        manifestJson: stableSerialize(transcriptManifest),
        createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId,
        role: 'source-master',
        originalFileName: 'live-duas-horas.mp4',
        createdAt,
      },
    })
    await client.v2MediaTranscript.create({
      data: {
        id: transcriptId,
        workspaceId,
        projectId,
        sourceArtifactId: artifactId,
        sourceManifestId: transcriptManifestId,
        schemaVersion: transcript.schemaVersion,
        language: transcript.language,
        provider: transcript.provider,
        model: transcript.model,
        transcriptHash: transcript.transcriptHash,
        transcriptJson: stableSerialize(transcript),
        createdAt,
      },
    })
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => createdAt,
      createId: () => `hierarchical-e2e-rights-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['editorial-reuse'],
        prohibitedUses: ['synthetic-generation'],
        allowedLocales: ['pt-BR'],
        consent: {
          status: 'not-required',
          allowedUses: [],
        },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })
    const artifactCountBefore =
      await client.v2MediaArtifact.count({ where: { workspaceId } })

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
    server.stdout.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    server.stderr.on('data', (chunk) => {
      serverLogs += String(chunk)
    })
    await waitForServer(baseUrl, server)

    const endpoint =
      `${baseUrl}/v1/projects/${projectId}` +
      '/hierarchical-processing/runs'
    const authorization = `Bearer ${issued.token}`
    const headers = {
      authorization,
      'content-type': 'application/json',
    }
    const body = {
      sourceArtifactId: artifactId,
      expectedArtifactSha256: artifactSha256,
      sourceManifestId: manifestId,
      expectedManifestHash: manifest.manifestHash,
      sourceTranscriptId: transcriptId,
      expectedTranscriptHash: transcript.transcriptHash,
      processingPolicyVersion: 'hierarchical-processing/v1',
      chunking: {
        policyVersion: 'overlapping-time-chunks/v1',
        chunkDurationMs: 300_000,
        overlapMs: 15_000,
      },
      tierVersions: tierVersions(),
      budget: {
        currency: 'USD',
        maxCostMinorUnits: 10_000,
        maxWorkingSetBytes: 268_435_456,
        maxElapsedMs: 1_800_000,
      },
    }
    const unauthenticated = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(unauthenticated.status, 401)

    const firstKey = `hierarchical-first-${suffix}`
    const firstResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': firstKey },
      body: JSON.stringify(body),
    })
    const firstPayload = await firstResponse.json()
    assert.equal(
      firstResponse.status,
      201,
      JSON.stringify(firstPayload),
    )
    assert.equal(firstPayload.data.replayed, false)
    const first = firstPayload.data.run
    assert.equal(first.durationMs, 7_200_000)
    assert.equal(first.chunks.length, 24)
    assert.deepEqual(first.chunks[1].coreRangeMs, [
      300_000,
      600_000,
    ])
    assert.deepEqual(first.chunks[1].sourceRangeMs, [
      285_000,
      615_000,
    ])
    assert.equal(first.chunks[1].overlapBeforeMs, 15_000)
    assert.equal(first.chunks[1].overlapAfterMs, 15_000)
    assert.deepEqual(first.plan.executionOrder, [
      'cheap-signals',
      'vision',
      'language',
      'aggregation',
    ])
    assert.equal(first.plan.cheapSignalsFirst, true)
    assert.deepEqual(
      first.tierExecutions.map((execution) => execution.status),
      ['processed', 'processed', 'processed', 'processed'],
    )
    assert.equal(first.aggregation.evidencePreserved, true)
    assert.equal(first.aggregation.moments.length, 24)
    assert.equal(first.aggregation.chapters.length, 6)
    assert.equal(first.evidenceSpans.length, 24)
    assert.equal(
      first.aggregation.moments.flatMap(
        (moment) => moment.evidenceSpanIds,
      ).length,
      24,
    )
    assert.equal(
      first.evidenceSpans.some((span) => 'text' in span),
      false,
    )
    assert.equal('requestFingerprint' in first, false)
    assert.equal('idempotencyKey' in first, false)
    assert.equal(first.physicalMaterialized, false)
    assert.equal(first.measurement.bounded, true)
    assert.equal(first.measurement.chunkCount, 24)
    assert.ok(first.measurement.workingSetBytes > 0)
    assert.equal(first.measurement.cost.minorUnits, 144)
    assert.ok(first.measurement.elapsedMs >= 4)

    const replayResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': firstKey },
      body: JSON.stringify(body),
    })
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200)
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.run.id, first.id)

    const mismatchResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': firstKey },
      body: JSON.stringify({
        ...body,
        budget: { ...body.budget, maxElapsedMs: 1_700_000 },
      }),
    })
    assert.equal(mismatchResponse.status, 409)

    const staleResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `hierarchical-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...body,
        expectedTranscriptHash: 'f'.repeat(64),
      }),
    })
    assert.equal(staleResponse.status, 409)

    const budgetResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `hierarchical-budget-${suffix}`,
      },
      body: JSON.stringify({
        ...body,
        budget: { ...body.budget, maxCostMinorUnits: 10 },
      }),
    })
    assert.equal(budgetResponse.status, 422)
    assert.equal(
      await client.v2HierarchicalProcessingRun.count({
        where: { workspaceId },
      }),
      1,
    )

    const readResponse = await fetch(`${endpoint}/${first.id}`, {
      headers: { authorization },
    })
    const readPayload = await readResponse.json()
    assert.equal(readResponse.status, 200)
    assert.equal(readPayload.data.run.runHash, first.runHash)
    assert.equal(readPayload.data.run.chunks.length, 24)

    const secondBody = {
      ...body,
      previousRun: {
        id: first.id,
        expectedRunHash: first.runHash,
      },
      tierVersions: tierVersions('2.0.0'),
    }
    const secondResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `hierarchical-second-${suffix}`,
      },
      body: JSON.stringify(secondBody),
    })
    const secondPayload = await secondResponse.json()
    assert.equal(
      secondResponse.status,
      201,
      JSON.stringify(secondPayload),
    )
    const second = secondPayload.data.run
    assert.deepEqual(second.plan.invalidatedTiers, [
      'vision',
      'aggregation',
    ])
    assert.deepEqual(second.plan.executionOrder, [
      'vision',
      'aggregation',
    ])
    assert.deepEqual(
      second.tierExecutions.map((execution) => execution.status),
      ['reused', 'processed', 'reused', 'processed'],
    )
    assert.equal(
      second.tierExecutions[0].reusedFromRunId,
      first.id,
    )
    assert.equal(
      second.tierExecutions[2].reusedFromRunId,
      first.id,
    )
    assert.equal(
      second.tierExecutions[0].outputHash,
      first.tierExecutions[0].outputHash,
    )
    assert.equal(
      second.tierExecutions[2].outputHash,
      first.tierExecutions[2].outputHash,
    )
    assert.equal(second.measurement.processedTierCount, 2)
    assert.equal(second.measurement.reusedTierCount, 2)
    assert.equal(second.measurement.cost.minorUnits, 96)
    assert.ok(
      second.measurement.workingSetBytes <
        first.measurement.workingSetBytes,
    )

    const concurrentBody = {
      ...secondBody,
      previousRun: {
        id: second.id,
        expectedRunHash: second.runHash,
      },
      tierVersions: {
        ...secondBody.tierVersions,
        aggregation: {
          ...secondBody.tierVersions.aggregation,
          version: '2.0.0',
        },
      },
    }
    const concurrentKey = `hierarchical-concurrent-${suffix}`
    const concurrent = await Promise.all(
      [0, 1].map(() => fetch(endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': concurrentKey,
        },
        body: JSON.stringify(concurrentBody),
      })),
    )
    const concurrentPayloads = await Promise.all(
      concurrent.map((response) => response.json()),
    )
    assert.deepEqual(
      concurrent.map((response) => response.status).sort(),
      [200, 201],
    )
    assert.equal(
      concurrentPayloads[0].data.run.id,
      concurrentPayloads[1].data.run.id,
    )
    assert.deepEqual(
      concurrentPayloads[0].data.run.plan.invalidatedTiers,
      ['aggregation'],
    )
    assert.equal(
      concurrentPayloads[0].data.run.measurement.cost.minorUnits,
      24,
    )

    const activeRuns =
      await client.v2HierarchicalProcessingRun.findMany({
        where: {
          workspaceId,
          projectId,
          sourceArtifactId: artifactId,
          sourceTranscriptId: transcriptId,
          active: true,
        },
      })
    assert.equal(activeRuns.length, 1)
    assert.equal(
      activeRuns[0].id,
      concurrentPayloads[0].data.run.id,
    )
    assert.equal(
      await client.v2HierarchicalProcessingRun.count({
        where: { workspaceId },
      }),
      3,
    )
    assert.equal(
      await client.v2HierarchicalProcessingChunk.count({
        where: { workspaceId },
      }),
      72,
    )
    assert.equal(
      await client.v2HierarchicalTierExecution.count({
        where: { workspaceId },
      }),
      12,
    )
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBefore,
      'hierarchical processing must not materialize media',
    )

    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "hierarchical_processing_chunks"
          SET "physicalMaterialized" = TRUE
          WHERE "id" = ${first.chunks[0].id}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "hierarchical_tier_executions"
          SET "status" = 'reused',
              "reusedFromRunId" = NULL,
              "elapsedMs" = 0
          WHERE "runId" = ${first.id}
            AND "tier" = 'vision'
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
