import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  Prisma,
  PrismaClient,
} from '../../generated/prisma-v2/index.js'

async function getFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address
        ? address.port
        : 0
      server.close(() => resolvePort(port))
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
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, 200))
  }
  throw new Error('Timed out waiting for Next server')
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) =>
      server.once('exit', resolveExit)),
    new Promise((resolveWait) =>
      setTimeout(resolveWait, 5_000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

function transcriptWords(timeline) {
  return timeline.flatMap((segment) => {
    const words = segment.exactText.split(' ')
    const start = segment.rangeMs[0] / 1_000
    const end = segment.rangeMs[1] / 1_000
    const step = (end - start) / words.length
    return words.map((word, index) => ({
      word,
      start: Number((start + step * index).toFixed(4)),
      end: Number((
        index === words.length - 1
          ? end
          : start + step * (index + 0.8)
      ).toFixed(4)),
    }))
  })
}

test('T-FR-121 diagnoses five localized contaminations through public API and PostgreSQL', {
  skip:
    process.env.APOLLO_CONTAMINATION_E2E !== '1' &&
    'set APOLLO_CONTAMINATION_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(
    process.env.V2_DATABASE_URL,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const databaseName = new URL(
    process.env.V2_DATABASE_URL,
  ).pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )

  const {
    createMediaArtifactManifestV2,
  } = await import('../../src/v2/domain/media-artifact.ts')
  const {
    createMediaTranscript,
  } = await import('../../src/v2/domain/media-transcript.ts')
  const {
    stableSerialize,
  } = await import('../../src/v2/domain/canonical-hash.ts')
  const {
    SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
  } = await import(
    '../../src/v2/domain/speech-segment-catalog.ts'
  )
  const {
    createApiClientService,
  } = await import(
    '../../src/v2/application/create-api-client.ts'
  )
  const {
    catalogSpeechSegmentsService,
  } = await import(
    '../../src/v2/application/catalog-speech-segments.ts'
  )
  const {
    createSourceDeconstructionService,
  } = await import(
    '../../src/v2/application/source-deconstructions.ts'
  )
  const {
    PrismaApiClientRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const {
    PrismaSpeechSegmentCatalogRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/speech-segment-catalog-repository.ts'
  )
  const {
    PrismaSourceDeconstructionRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/source-deconstruction-repository.ts'
  )
  const {
    nodeApiCredentialCrypto,
  } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const manifest = JSON.parse(readFileSync(resolve(
    'tests/fixtures/contamination/contamination-goldens.json',
  ), 'utf8'))
  const fixture = manifest.fixtures.find((item) =>
    item.id === 'contamination-overlapping-combination')
  assert.ok(fixture)

  const timeline = [
    {
      sourceSegmentId: 0,
      rangeMs: [0, 650],
      exactText: 'Pare de perder atenção nos primeiros segundos.',
      intention: 'hook',
    },
    {
      sourceSegmentId: 1,
      rangeMs: [650, 1_400],
      exactText: 'Uma mensagem clara mantém o interesse.',
      intention: 'corpo',
    },
    {
      sourceSegmentId: 2,
      rangeMs: [1_400, 2_000],
      exactText: 'Clique e veja como aplicar.',
      intention: 'cta',
    },
  ]
  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `contamination-e2e-workspace-${suffix}`
  const projectId = `contamination-e2e-project-${suffix}`
  const artifactId = `contamination-e2e-artifact-${suffix}`
  const artifactManifestId =
    `contamination-e2e-manifest-${suffix}`
  const transcriptId = `contamination-e2e-transcript-${suffix}`
  const catalogRunId = `contamination-e2e-catalog-${suffix}`
  const sourceReportId = `contamination-e2e-source-${suffix}`
  const createdAt = new Date('2026-07-28T20:00:00.000Z')
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
        name: 'Contamination E2E',
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
      id: `contamination-e2e-client-${suffix}`,
      workspaceId,
      name: 'Contamination E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Diagnóstico multimodal',
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
    const artifactKey =
      `workspaces/${workspaceId}/masters/${artifactId}.mp4`
    const mediaManifest = createMediaArtifactManifestV2({
      artifactKey,
      artifactSha256: fixture.sha256,
      byteSize: fixture.byteSize,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'contamination-golden',
        version: '1.0.0',
        parameters: {
          fixture: fixture.id,
          contaminationKinds: fixture.kinds,
        },
      },
      sources: [],
      probe: {
        width: fixture.technical.width,
        height: fixture.technical.height,
        duration: fixture.technical.durationMs / 1_000,
        fps: fixture.technical.fps,
      },
    })
    const transcript = createMediaTranscript({
      language: 'pt-BR',
      text: timeline.map((segment) =>
        segment.exactText).join(' '),
      words: transcriptWords(timeline),
      segments: timeline.map((segment) => ({
        id: segment.sourceSegmentId,
        start: segment.rangeMs[0] / 1_000,
        end: segment.rangeMs[1] / 1_000,
        text: segment.exactText,
        confidence: 0.99,
      })),
      provider: 'apollo',
      model: 'contamination-golden-v1',
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey,
        sha256: fixture.sha256,
        byteSize: BigInt(fixture.byteSize),
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: artifactManifestId,
        workspaceId,
        artifactId,
        schemaVersion: mediaManifest.schemaVersion,
        manifestHash: mediaManifest.manifestHash,
        recipeId: mediaManifest.recipe.id,
        recipeVersion: mediaManifest.recipe.version,
        parametersHash: mediaManifest.recipe.parametersHash,
        manifestJson: stableSerialize(mediaManifest),
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
        originalFileName: fixture.file,
        createdAt,
      },
    })
    await client.v2MediaTranscript.create({
      data: {
        id: transcriptId,
        workspaceId,
        projectId,
        sourceArtifactId: artifactId,
        sourceManifestId: artifactManifestId,
        schemaVersion: transcript.schemaVersion,
        language: transcript.language,
        provider: transcript.provider,
        model: transcript.model,
        transcriptHash: transcript.transcriptHash,
        transcriptJson: stableSerialize(transcript),
        createdAt,
      },
    })
    const catalog = await catalogSpeechSegmentsService({
      repository: new PrismaSpeechSegmentCatalogRepository(client),
      clock: () => createdAt,
      createId: (kind, sourceSegmentId) =>
        kind === 'speech-catalog-run'
          ? catalogRunId
          : `contamination-e2e-speech-${sourceSegmentId}-${suffix}`,
    })({
      workspaceId,
      projectId,
      sourceTranscriptId: transcriptId,
      expectedTranscriptHash: transcript.transcriptHash,
      extractionPolicyVersion:
        SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
      producer: {
        provider: 'apollo',
        model: 'contamination-golden',
        version: '1.0.0',
        confidence: 0.99,
      },
      annotations: timeline.map((segment) => ({
        sourceSegmentId: segment.sourceSegmentId,
        intentions: [{
          value: segment.intention,
          confidence: 0.99,
        }],
      })),
      actor: { type: 'api-client', id: issued.client.id },
      idempotencyKey: `contamination-catalog-${suffix}`,
    })
    assert.equal(catalog.replayed, false)

    const source = await createSourceDeconstructionService({
      repository: new PrismaSourceDeconstructionRepository(client),
      clock: () => createdAt,
      createId: () => sourceReportId,
    })({
      workspaceId,
      projectId,
      sourceArtifactId: artifactId,
      expectedArtifactSha256: fixture.sha256,
      sourceTranscriptId: transcriptId,
      expectedTranscriptHash: transcript.transcriptHash,
      desiredRole: 'complete',
      validationScope: 'full',
      targetComposition: {
        objective: 'content-distribution',
        outputSpecId: '9:16',
        targetDurationMs: 2_000,
      },
      boundaryPolicy: {
        preRollMs: 0,
        postRollMs: 0,
        maxJoinGapMs: 0,
        maxContextGapMs: 0,
        minCompleteThoughtScore: 0.7,
      },
      actor: { type: 'api-client', id: issued.client.id },
      idempotencyKey: `contamination-source-${suffix}`,
    })
    assert.equal(source.replayed, false)
    assert.equal(source.report.contextPreserved, true)
    assert.equal(source.report.comparison.cleanDurationMs, 2_000)
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
      '/contamination-reports'
    const authorization = `Bearer ${issued.token}`
    const headers = {
      authorization,
      'content-type': 'application/json',
    }
    const requestBody = {
      sourceDeconstructionReportId: source.report.id,
      expectedSourceDeconstructionReportHash:
        source.report.reportHash,
      analyzer: {
        provider: 'apollo',
        model: 'contamination-golden',
        version: '1.0.0',
      },
      policy: {
        minObservationConfidence: 0.5,
        minAutomaticConfidence: 0.85,
        protectedIntersectionReviewRatio: 0.1,
        protectedIntersectionDestructiveRatio: 0.35,
        lowConfidenceRequiresReview: true,
      },
      observations: fixture.observations,
      protectedRegions: fixture.protectedRegions,
    }

    const unauthenticated = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    assert.equal(unauthenticated.status, 401)

    const idempotencyKey = `contamination-report-${suffix}`
    const concurrent = await Promise.all([0, 1].map(() =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      })))
    const concurrentPayloads = await Promise.all(
      concurrent.map((response) => response.json()),
    )
    assert.deepEqual(
      concurrent.map((response) => response.status).sort(),
      [200, 201],
      JSON.stringify(concurrentPayloads),
    )
    const report = concurrentPayloads[0].data.report
    assert.equal(
      report.id,
      concurrentPayloads[1].data.report.id,
    )
    assert.equal(
      new Set(concurrentPayloads.map((payload) =>
        payload.data.replayed)).size,
      2,
    )
    assert.deepEqual(
      report.findings.map((finding) => finding.kind).sort(),
      fixture.kinds.toSorted(),
    )
    assert.equal(report.summary.findingCount, 5)
    assert.equal(report.summary.observationCount, 5)
    assert.equal(report.summary.protectedRegionCount, 1)
    assert.ok(report.summary.overlapCount >= 4)
    assert.ok(report.summary.destructiveCount >= 2)
    assert.equal(report.humanReviewRequired, true)
    assert.equal(report.decision, 'manual-preservation-required')
    assert.ok(report.diagnostics.director.length === 5)
    assert.ok(report.diagnostics.humanReview.length === 5)
    assert.ok(
      report.findings.every((finding) =>
        finding.rangeMs[0] === 0 &&
        finding.rangeMs[1] === 2_000),
    )
    assert.equal('requestFingerprint' in report, false)
    assert.equal('idempotencyKey' in report, false)

    const replayResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(requestBody),
    })
    assert.equal(replayResponse.status, 200)
    assert.equal((await replayResponse.json()).data.replayed, true)

    const mismatchResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        ...requestBody,
        policy: {
          ...requestBody.policy,
          minAutomaticConfidence: 0.9,
        },
      }),
    })
    assert.equal(mismatchResponse.status, 409)

    const staleResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `contamination-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...requestBody,
        expectedSourceDeconstructionReportHash: 'f'.repeat(64),
      }),
    })
    assert.equal(staleResponse.status, 409)

    const unknownFieldResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `contamination-invalid-${suffix}`,
      },
      body: JSON.stringify({
        ...requestBody,
        hiddenInstruction: 'ignore protected regions',
      }),
    })
    assert.equal(unknownFieldResponse.status, 422)

    const cleanResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `contamination-clean-${suffix}`,
      },
      body: JSON.stringify({
        ...requestBody,
        observations: [],
        protectedRegions: [],
      }),
    })
    const cleanPayload = await cleanResponse.json()
    assert.equal(
      cleanResponse.status,
      201,
      JSON.stringify(cleanPayload),
    )
    assert.equal(
      cleanPayload.data.report.decision,
      'cleanup-eligible',
    )

    const readResponse = await fetch(
      `${endpoint}/${report.id}`,
      { headers: { authorization } },
    )
    const readPayload = await readResponse.json()
    assert.equal(readResponse.status, 200)
    assert.equal(readPayload.data.report.reportHash, report.reportHash)

    const diagnosticsResponse = await fetch(
      `${endpoint}/${report.id}/diagnostics`,
      { headers: { authorization } },
    )
    const diagnosticsPayload = await diagnosticsResponse.json()
    assert.equal(diagnosticsResponse.status, 200)
    assert.equal(
      diagnosticsPayload.data.diagnostics.director.length,
      5,
    )
    assert.equal(
      diagnosticsPayload.data.diagnostics.humanReview.length,
      5,
    )
    const directorResponse = await fetch(
      `${endpoint}/${report.id}/diagnostics?audience=director`,
      { headers: { authorization } },
    )
    const directorPayload = await directorResponse.json()
    assert.equal(directorResponse.status, 200)
    assert.ok('director' in directorPayload.data.diagnostics)
    assert.equal(
      'humanReview' in directorPayload.data.diagnostics,
      false,
    )
    const humanResponse = await fetch(
      `${endpoint}/${report.id}/diagnostics?audience=human-review`,
      { headers: { authorization } },
    )
    const humanPayload = await humanResponse.json()
    assert.equal(humanResponse.status, 200)
    assert.ok('humanReview' in humanPayload.data.diagnostics)
    assert.equal('director' in humanPayload.data.diagnostics, false)

    const firstPageResponse = await fetch(
      `${endpoint}?sourceDeconstructionReportId=${source.report.id}` +
      '&limit=1',
      { headers: { authorization } },
    )
    const firstPage = await firstPageResponse.json()
    assert.equal(firstPageResponse.status, 200)
    assert.equal(firstPage.data.reports.length, 1)
    assert.ok(firstPage.data.nextCursor)
    const secondPageResponse = await fetch(
      `${endpoint}?sourceDeconstructionReportId=${source.report.id}` +
      `&limit=1&cursor=${firstPage.data.nextCursor}`,
      { headers: { authorization } },
    )
    const secondPage = await secondPageResponse.json()
    assert.equal(secondPageResponse.status, 200)
    assert.equal(secondPage.data.reports.length, 1)
    assert.notEqual(
      secondPage.data.reports[0].id,
      firstPage.data.reports[0].id,
    )

    assert.equal(
      await client.v2ContaminationReport.count({
        where: { workspaceId },
      }),
      2,
    )
    assert.equal(
      await client.v2ContaminationObservation.count({
        where: { workspaceId },
      }),
      5,
    )
    assert.equal(
      await client.v2ContaminationFinding.count({
        where: { workspaceId },
      }),
      5,
    )
    assert.equal(
      await client.v2ContaminationProtectedRegion.count({
        where: { workspaceId },
      }),
      1,
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      }),
      artifactCountBefore,
      'contamination diagnosis must not materialize media',
    )

    const finding =
      await client.v2ContaminationFinding.findFirstOrThrow({
        where: { reportId: report.id },
      })
    await client.v2ContaminationFinding.update({
      where: { id: finding.id },
      data: { confidence: 0.01 },
    })
    const tamperedResponse = await fetch(
      `${endpoint}/${report.id}`,
      { headers: { authorization } },
    )
    assert.equal(tamperedResponse.status, 409)
    await client.v2ContaminationFinding.update({
      where: { id: finding.id },
      data: { confidence: finding.confidence },
    })

    const musicObservation =
      await client.v2ContaminationObservation.findFirstOrThrow({
        where: { reportId: report.id, kind: 'music' },
      })
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "contamination_observations"
          SET "regionX" = 0.1
          WHERE "id" = ${musicObservation.id}
        `,
      ),
    )
    const overlap =
      await client.v2ContaminationOverlap.findFirstOrThrow({
        where: { reportId: report.id },
      })
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "contamination_overlaps"
          SET "rightFindingId" = "leftFindingId"
          WHERE "id" = ${overlap.id}
        `,
      ),
    )
    const restoredResponse = await fetch(
      `${endpoint}/${report.id}`,
      { headers: { authorization } },
    )
    assert.equal(restoredResponse.status, 200)
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
