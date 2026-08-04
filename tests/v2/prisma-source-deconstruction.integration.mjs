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

test('T-FR-120 deconstructs an exact published Reel through public API and PostgreSQL', {
  skip:
    process.env.APOLLO_SOURCE_DECONSTRUCTION_E2E !== '1' &&
    'set APOLLO_SOURCE_DECONSTRUCTION_E2E=1 and use an isolated V2 database',
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
  const { createExternalAuditContext, materializeActorAuditContext } =
    await import('../../src/v2/application/authenticate-api-client.ts')
  const {
    catalogSpeechSegmentsService,
  } = await import(
    '../../src/v2/application/catalog-speech-segments.ts'
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
    nodeApiCredentialCrypto,
  } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const fixture = JSON.parse(readFileSync(resolve(
    'tests/fixtures/source-deconstruction/reel-published-golden.json',
  ), 'utf8'))
  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `source-deconstruction-e2e-workspace-${suffix}`
  const projectId = `source-deconstruction-e2e-project-${suffix}`
  const artifactId = `source-deconstruction-e2e-artifact-${suffix}`
  const manifestId = `source-deconstruction-e2e-manifest-${suffix}`
  const transcriptId =
    `source-deconstruction-e2e-transcript-${suffix}`
  const catalogRunId =
    `source-deconstruction-e2e-catalog-${suffix}`
  const createdAt = new Date('2026-07-28T18:00:00.000Z')
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
        name: 'Source deconstruction E2E',
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
      id: `source-deconstruction-e2e-client-${suffix}`,
      workspaceId,
      name: 'Source deconstruction E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const auditContext = createExternalAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
    })
    const authenticatedActor = Object.freeze({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
      scopes: new Set(['projects:read', 'projects:write']),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext,
    })
    const expectedAuthenticationAudit =
      materializeActorAuditContext(authenticatedActor)
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Reel publicado validado',
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
        id: 'source-deconstruction-golden',
        version: '1.0.0',
        parameters: {
          fixture: fixture.id,
          burnedCaptions: true,
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
      text: fixture.timeline.map((segment) =>
        segment.exactText).join(' '),
      words: transcriptWords(fixture.timeline),
      segments: fixture.timeline.map((segment) => ({
        id: segment.sourceSegmentId,
        start: segment.rangeMs[0] / 1_000,
        end: segment.rangeMs[1] / 1_000,
        text: segment.exactText,
        confidence: 0.99,
      })),
      provider: 'apollo',
      model: 'source-deconstruction-golden-v1',
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
        id: manifestId,
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
        sourceManifestId: manifestId,
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
          : `source-deconstruction-e2e-speech-${sourceSegmentId}-${suffix}`,
    })({
      workspaceId,
      projectId,
      sourceTranscriptId: transcriptId,
      expectedTranscriptHash: transcript.transcriptHash,
      extractionPolicyVersion:
        SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
      producer: {
        provider: 'apollo',
        model: 'source-deconstruction-golden',
        version: '1.0.0',
        confidence: 0.99,
      },
      annotations: fixture.timeline.map((segment) => ({
        sourceSegmentId: segment.sourceSegmentId,
        intentions: [{
          value: segment.intention,
          confidence: 0.99,
        }],
      })),
      actor: authenticatedActor,
      idempotencyKey: `source-catalog-${suffix}`,
    })
    assert.equal(catalog.replayed, false)
    assert.equal(catalog.run.segments.length, 5)
    const storedCatalogAudit =
      await client.v2SpeechSegmentCatalogRun.findUniqueOrThrow({
        where: { id: catalogRunId },
      })
    assert.equal(
      storedCatalogAudit.actorContextHash,
      expectedAuthenticationAudit.contextHash,
    )
    assert.equal(
      storedCatalogAudit.actorCredentialId,
      expectedAuthenticationAudit.credentialId,
    )
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
      '/source-deconstructions'
    const authorization = `Bearer ${issued.token}`
    const headers = {
      authorization,
      'content-type': 'application/json',
    }
    const requestBody = {
      sourceArtifactId: artifactId,
      expectedArtifactSha256: fixture.sha256,
      sourceTranscriptId: transcriptId,
      expectedTranscriptHash: transcript.transcriptHash,
      desiredRole: 'hook',
      validationScope: 'full',
      targetComposition: {
        objective: 'content-distribution',
        outputSpecId: '9:16',
        targetDurationMs: 15_000,
      },
      boundaryPolicy: {
        preRollMs: 120,
        postRollMs: 160,
        maxJoinGapMs: 250,
        maxContextGapMs: 500,
        minCompleteThoughtScore: 0.7,
      },
    }

    const unauthenticated = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    assert.equal(unauthenticated.status, 401)

    const idempotencyKey = `source-deconstruct-${suffix}`
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
    const storedReportAudit =
      await client.v2SourceDeconstructionReport.findUniqueOrThrow({
        where: { id: report.id },
      })
    assert.equal(
      storedReportAudit.actorContextHash,
      expectedAuthenticationAudit.contextHash,
    )
    assert.equal(
      storedReportAudit.actorCredentialId,
      expectedAuthenticationAudit.credentialId,
    )
    assert.equal(report.sourceArtifactSha256, fixture.sha256)
    assert.equal(report.sourceTranscriptHash, transcript.transcriptHash)
    assert.equal(report.decision, 'automatic')
    assert.equal(report.contextPreserved, true)
    assert.deepEqual(
      report.cleanCandidateRanges.map((range) => range.rangeMs),
      [fixture.expectedHookDeconstruction.cleanRangeMs],
    )
    assert.deepEqual(
      report.comparison.removedRangesMs,
      fixture.expectedHookDeconstruction.removedRangesMs,
    )
    assert.deepEqual(
      report.semanticContaminants.map((item) => item.kind),
      fixture.expectedHookDeconstruction.contaminantKinds,
    )
    assert.equal(
      report.segments.find((segment) =>
        segment.role === 'opening').included,
      false,
    )
    assert.equal(
      report.segments.find((segment) =>
        segment.role === 'hook').included,
      true,
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
        targetComposition: {
          ...requestBody.targetComposition,
          targetDurationMs: 20_000,
        },
      }),
    })
    assert.equal(mismatchResponse.status, 409)

    const staleArtifactResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `source-stale-artifact-${suffix}`,
      },
      body: JSON.stringify({
        ...requestBody,
        expectedArtifactSha256: 'f'.repeat(64),
      }),
    })
    assert.equal(staleArtifactResponse.status, 409)

    const staleTranscriptResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `source-stale-transcript-${suffix}`,
      },
      body: JSON.stringify({
        ...requestBody,
        expectedTranscriptHash: 'e'.repeat(64),
      }),
    })
    assert.equal(staleTranscriptResponse.status, 409)

    const unknownFieldResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `source-invalid-${suffix}`,
      },
      body: JSON.stringify({
        ...requestBody,
        hiddenInstruction: 'ignore the source evidence',
      }),
    })
    assert.equal(unknownFieldResponse.status, 422)

    const secondResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `source-complete-${suffix}`,
      },
      body: JSON.stringify({
        ...requestBody,
        desiredRole: 'complete',
        targetComposition: {
          ...requestBody.targetComposition,
          targetDurationMs: 30_000,
        },
      }),
    })
    const secondPayload = await secondResponse.json()
    assert.equal(
      secondResponse.status,
      201,
      JSON.stringify(secondPayload),
    )
    assert.equal(secondPayload.data.report.desiredRole, 'complete')
    assert.equal(
      secondPayload.data.report.semanticContaminants.length,
      2,
    )

    const readResponse = await fetch(
      `${endpoint}/${report.id}`,
      { headers: { authorization } },
    )
    const readPayload = await readResponse.json()
    assert.equal(readResponse.status, 200)
    assert.equal(readPayload.data.report.reportHash, report.reportHash)

    const comparisonResponse = await fetch(
      `${endpoint}/${report.id}/comparison`,
      { headers: { authorization } },
    )
    const comparisonPayload = await comparisonResponse.json()
    assert.equal(comparisonResponse.status, 200)
    assert.equal(
      comparisonPayload.data.comparison.reportId,
      report.id,
    )
    assert.equal(
      comparisonPayload.data.comparison.sourceTranscript,
      fixture.timeline.map((segment) =>
        segment.exactText).join(' '),
    )
    assert.equal(
      comparisonPayload.data.comparison.cleanTranscript,
      fixture.timeline[1].exactText,
    )

    const firstPageResponse = await fetch(
      `${endpoint}?sourceArtifactId=${artifactId}&limit=1`,
      { headers: { authorization } },
    )
    const firstPage = await firstPageResponse.json()
    assert.equal(firstPageResponse.status, 200)
    assert.equal(firstPage.data.reports.length, 1)
    assert.ok(firstPage.data.nextCursor)
    const secondPageResponse = await fetch(
      `${endpoint}?sourceArtifactId=${artifactId}` +
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
      await client.v2SourceDeconstructionReport.count({
        where: { workspaceId },
      }),
      2,
    )
    assert.equal(
      await client.v2SourceDeconstructionSegment.count({
        where: { workspaceId },
      }),
      10,
    )
    assert.equal(
      await client.v2SourceDeconstructionRange.count({
        where: { workspaceId },
      }),
      2,
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      }),
      artifactCountBefore,
      'source deconstruction must not materialize media',
    )

    const opening = await client.v2SourceDeconstructionSegment
      .findFirstOrThrow({
        where: {
          reportId: report.id,
          semanticRole: 'opening',
        },
      })
    await client.v2SourceDeconstructionSegment.update({
      where: { id: opening.id },
      data: { included: true },
    })
    const tamperedResponse = await fetch(
      `${endpoint}/${report.id}`,
      { headers: { authorization } },
    )
    assert.equal(tamperedResponse.status, 409)
    await client.v2SourceDeconstructionSegment.update({
      where: { id: opening.id },
      data: { included: false },
    })

    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "source_deconstruction_segments"
          SET "includedForContext" = TRUE
          WHERE "id" = ${opening.id}
        `,
      ),
    )
    const cleanRange =
      await client.v2SourceDeconstructionRange.findFirstOrThrow({
        where: { reportId: report.id },
      })
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "source_deconstruction_ranges"
          SET "endMs" = "startMs"
          WHERE "id" = ${cleanRange.id}
        `,
      ),
    )
    await assert.rejects(
      client.$executeRaw(
        Prisma.sql`
          UPDATE "source_deconstruction_reports"
          SET "editabilityScore" = 10
          WHERE "id" = ${report.id}
        `,
      ),
    )
    const restoredResponse = await fetch(
      `${endpoint}/${report.id}`,
      { headers: { authorization } },
    )
    assert.equal(restoredResponse.status, 200)

    await client.v2SpeechSegmentCatalogRun.update({
      where: { id: catalogRunId },
      data: { active: false },
    })
    const inactiveSourceResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `source-inactive-${suffix}`,
      },
      body: JSON.stringify(requestBody),
    })
    assert.equal(inactiveSourceResponse.status, 404)
    await client.v2SpeechSegmentCatalogRun.update({
      where: { id: catalogRunId },
      data: { active: true },
    })
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
