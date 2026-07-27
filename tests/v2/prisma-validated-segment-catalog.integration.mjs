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
      server.close((error) =>
        error
          ? reject(error)
          : resolve(
              typeof address === 'object' && address
                ? address.port
                : 0,
            ))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next server exited with ${child.exitCode}`)
    }
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-046 catalogs scoped historical validation and preflights compatible and incompatible recipes through API/PostgreSQL', {
  skip:
    process.env.APOLLO_VALIDATED_SEGMENT_E2E !== '1' &&
    'set APOLLO_VALIDATED_SEGMENT_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(
    process.env.V2_DATABASE_URL,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )

  const { assetRightsRevision } =
    await import('../../src/v2/domain/asset-rights.ts')
  const { createMediaArtifactManifestV2 } =
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
    await import('../../src/v2/infrastructure/security/api-credential.ts')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `validated-e2e-workspace-${suffix}`
  const projectId = `validated-e2e-project-${suffix}`
  const artifactId = `validated-e2e-artifact-${suffix}`
  const manifestId = `validated-e2e-manifest-${suffix}`
  const transcriptId = `validated-e2e-transcript-${suffix}`
  const createdAt = new Date('2026-07-27T15:30:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'ValidatedSegment catalog E2E',
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
      id: `validated-e2e-client-${suffix}`,
      workspaceId,
      name: 'ValidatedSegment catalog E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Validated hook E2E',
        status: 'draft',
        objective: 'lead-generation',
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
    const artifactSha256 = 'd'.repeat(64)
    const manifest = createMediaArtifactManifestV2({
      artifactKey,
      artifactSha256,
      byteSize: 800_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'controlled-validated-segment-e2e',
        version: '1.0.0',
        parameters: { fixture: 'validated-hook' },
      },
      sources: [],
      probe: {
        width: 1080,
        height: 1920,
        duration: 120,
        fps: 30,
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey,
        sha256: artifactSha256,
        byteSize: BigInt(800_000),
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
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId,
        role: 'source-master',
        originalFileName: 'validated-hook.mp4',
        createdAt,
      },
    })
    const transcript = createMediaTranscript({
      language: 'pt-BR',
      text: 'Pare de desperdiçar verba antes de validar seu criativo.',
      provider: 'controlled-e2e',
      model: 'validated-hook-alignment-v1',
      words: [
        { word: 'Pare', start: 1, end: 1.4 },
        { word: 'de', start: 1.41, end: 1.6 },
        { word: 'desperdiçar', start: 1.61, end: 2.3 },
        { word: 'verba', start: 2.31, end: 2.7 },
        { word: 'antes', start: 2.71, end: 3.1 },
        { word: 'de', start: 3.11, end: 3.3 },
        { word: 'validar', start: 3.31, end: 3.8 },
        { word: 'seu', start: 3.81, end: 4.1 },
        { word: 'criativo.', start: 4.11, end: 4.8 },
      ],
      segments: [{
        id: 10,
        start: 1,
        end: 4.8,
        text: 'Pare de desperdiçar verba antes de validar seu criativo.',
        confidence: 0.99,
      }],
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
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => createdAt,
      createId: () => `validated-e2e-rights-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: { status: 'not-required', allowedUses: [] },
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
    const authorization = `Bearer ${issued.token}`
    const speechResponse = await fetch(
      `${baseUrl}/v1/projects/${projectId}/speech-segments`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `validated-speech-${suffix}`,
        },
        body: JSON.stringify({
      sourceTranscriptId: transcriptId,
      expectedTranscriptHash: transcript.transcriptHash,
      extractionPolicyVersion: 'speech-segment-extraction/v1',
      producer: {
        provider: 'apollo',
        model: 'validated-segment-e2e',
        version: '1.0.0',
        confidence: 0.99,
      },
      annotations: [{
        sourceSegmentId: 10,
        speaker: { value: 'person-specialist', confidence: 0.99 },
        intentions: [{ value: 'Hook', confidence: 0.98 }],
      }],
        }),
      },
    )
    const speechPayload = await speechResponse.json()
    assert.equal(
      speechResponse.status,
      201,
      JSON.stringify(speechPayload),
    )
    const speechSegment = speechPayload.data.run.segments[0]
    assert.ok(speechSegment)

    const endpoint =
      `${baseUrl}/v1/projects/${projectId}/validated-segments`
    const hookBody = {
      sourceArtifactId: artifactId,
      expectedArtifactSha256: artifactSha256,
      sourceManifestId: manifestId,
      expectedManifestHash: manifest.manifestHash,
      sourceSpeechSegmentId: speechSegment.id,
      expectedSpeechSegmentHash: speechSegment.segmentHash,
      policyVersion: 'validated-segment/v1',
      scope: {
        unit: 'hook',
        evidenceScope: 'opening-edit',
      },
      source: {
        platform: 'instagram',
        publicationRef: 'reel-e2e-validated-hook',
        accountRef: '@especialista',
        url: 'https://www.instagram.com/reel/e2e-validated-hook/',
        observedAt: '2026-07-01T12:00:00.000Z',
      },
      performance: {
        metric: 'three-second-hold-rate',
        value: 0.81,
        unit: 'ratio',
        sampleSize: 25_000,
        period: {
          start: '2026-07-01T12:00:00.000Z',
          end: '2026-07-10T12:00:00.000Z',
        },
        comparison: {
          label: 'Median previous publications',
          value: 0.56,
          unit: 'ratio',
        },
      },
      validatedAt: '2026-07-20T12:00:00.000Z',
      expiresAt: '2027-01-20T12:00:00.000Z',
    }
    const key = `validated-hook-${suffix}`
    const created = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(hookBody),
    })
    const createdPayload = await created.json()
    assert.equal(created.status, 201, JSON.stringify(createdPayload))
    const hook = createdPayload.data.segment
    assert.equal(createdPayload.data.replayed, false)
    assert.equal(hook.scope.unit, 'hook')
    assert.equal(hook.wholeVideoValidated, false)
    assert.deepEqual(
      hook.protectedEnvelope.protectedAspects,
      ['copy', 'take', 'timing', 'opening'],
    )
    assert.equal(hook.protectedEnvelope.exactCopy, speechSegment.exactText)
    assert.equal(hook.causalClaimAllowed, false)
    assert.equal(hook.physicalMaterialized, false)
    assert.equal('requestFingerprint' in hook, false)
    assert.equal('idempotencyKey' in hook, false)

    const replay = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(hookBody),
    })
    const replayPayload = await replay.json()
    assert.equal(replay.status, 200)
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.segment.id, hook.id)

    const mismatch = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({
        ...hookBody,
        performance: { ...hookBody.performance, value: 0.7 },
      }),
    })
    assert.equal(mismatch.status, 409)

    const staleSource = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `validated-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...hookBody,
        expectedSpeechSegmentHash: 'f'.repeat(64),
      }),
    })
    const staleSourcePayload = await staleSource.json()
    assert.equal(staleSource.status, 409)
    assert.equal(staleSourcePayload.error.code, 'VERSION_CONFLICT')

    const wholeBody = {
      ...hookBody,
      sourceSpeechSegmentId: undefined,
      expectedSpeechSegmentHash: undefined,
      scope: {
        unit: 'whole-video',
        evidenceScope: 'copy',
      },
      source: {
        platform: 'youtube',
        publicationRef: 'video-e2e-whole-validation',
        observedAt: '2026-07-02T12:00:00.000Z',
      },
      performance: {
        metric: 'average-watch-seconds',
        value: 47.5,
        unit: 'seconds',
        sampleSize: 40_000,
        period: {
          start: '2026-07-02T12:00:00.000Z',
          end: '2026-07-12T12:00:00.000Z',
        },
      },
    }
    const whole = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `validated-whole-${suffix}`,
      },
      body: JSON.stringify(wholeBody),
    })
    const wholePayload = await whole.json()
    assert.equal(whole.status, 201, JSON.stringify(wholePayload))
    assert.equal(wholePayload.data.segment.wholeVideoValidated, true)
    assert.deepEqual(
      wholePayload.data.segment.protectedEnvelope.sourceRangeMs,
      [0, 120_000],
    )

    const searchUrl = new URL(endpoint)
    searchUrl.searchParams.set('q', 'desperdicar verba')
    searchUrl.searchParams.set('platform', 'INSTAGRAM')
    searchUrl.searchParams.set('unit', 'hook')
    searchUrl.searchParams.set('evidenceScope', 'opening-edit')
    searchUrl.searchParams.set('metric', 'THREE-SECOND-HOLD-RATE')
    searchUrl.searchParams.set('activeOnly', 'true')
    const search = await fetch(searchUrl, {
      headers: { authorization },
    })
    const searchPayload = await search.json()
    assert.equal(search.status, 200, JSON.stringify(searchPayload))
    assert.equal(searchPayload.data.results.length, 1)
    assert.equal(searchPayload.data.results[0].segment.id, hook.id)
    assert.deepEqual(searchPayload.data.results[0].matchedBy, [
      'text',
      'platform',
      'unit',
      'evidence-scope',
      'metric',
      'active-at',
    ])
    assert.equal(searchPayload.data.results[0].eligibleForReuse, true)

    const preflightEndpoint =
      `${endpoint}/${hook.id}/reuse-preflight`
    const compatibleBody = {
      targetRecipe: {
        id: 'recipe-compatible-e2e',
        role: 'hook',
        objective: 'lead-generation',
        format: '9:16',
        locale: 'pt-BR',
      },
      requestedChanges: [],
      claim: 'historical-association',
    }
    const compatible = await fetch(preflightEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(compatibleBody),
    })
    const compatiblePayload = await compatible.json()
    assert.equal(compatible.status, 200, JSON.stringify(compatiblePayload))
    assert.equal(compatiblePayload.data.decision.compatible, true)
    assert.equal(
      compatiblePayload.data.decision.performanceInterpretation,
      'historical-association',
    )
    assert.equal(
      compatiblePayload.data.decision.causalClaimAllowed,
      false,
    )

    const incompatible = await fetch(preflightEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...compatibleBody,
        targetRecipe: {
          ...compatibleBody.targetRecipe,
          role: 'body',
        },
        requestedChanges: ['copy', 'timing'],
        claim: 'causality',
      }),
    })
    const incompatiblePayload = await incompatible.json()
    assert.equal(incompatible.status, 200)
    assert.equal(incompatiblePayload.data.decision.compatible, false)
    assert.deepEqual(incompatiblePayload.data.decision.reasons, [
      'VALIDATION_UNIT_HOOK_ONLY',
      'PROTECTED_COPY',
      'PROTECTED_TIMING',
      'CAUSALITY_NOT_SUPPORTED',
    ])
    assert.equal(
      incompatiblePayload.data.decision.causalClaimAllowed,
      false,
    )

    const unauthenticated = await fetch(endpoint)
    assert.equal(unauthenticated.status, 401)
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBefore,
    )
    assert.equal(
      await client.v2ValidatedSegment.count({
        where: {
          workspaceId,
          projectId,
          physicalMaterialized: false,
          causalClaimAllowed: false,
        },
      }),
      2,
    )
    await assert.rejects(
      client.v2ValidatedSegment.update({
        where: { id: hook.id },
        data: { causalClaimAllowed: true },
      }),
      /validated_segments_policy_check/,
    )
    await assert.rejects(
      client.v2ValidatedSegment.update({
        where: { id: hook.id },
        data: { physicalMaterialized: true },
      }),
      /validated_segments_policy_check/,
    )

    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => new Date(createdAt.getTime() + 1_000),
      createId: () => `validated-e2e-rights-rotated-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 1),
      draft: {
        status: 'approved',
        allowedUses: ['rendering'],
        prohibitedUses: ['synthetic-generation'],
        allowedLocales: ['pt-BR'],
        consent: { status: 'not-required', allowedUses: [] },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })
    const staleRights = await fetch(preflightEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(compatibleBody),
    })
    const staleRightsPayload = await staleRights.json()
    assert.equal(staleRights.status, 200)
    assert.equal(staleRightsPayload.data.decision.compatible, false)
    assert.deepEqual(
      staleRightsPayload.data.decision.reasons,
      ['RIGHTS_SNAPSHOT_STALE'],
    )

    const concurrent = await Promise.all(
      ['a', 'b'].map(async (label) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key':
              `validated-concurrent-${label}-${suffix}`,
          },
          body: JSON.stringify({
            ...hookBody,
            source: {
              ...hookBody.source,
              publicationRef: `reel-concurrent-${label}-${suffix}`,
            },
          }),
        })
        return {
          status: response.status,
          payload: await response.json(),
        }
      }),
    )
    assert.deepEqual(
      concurrent.map((response) => response.status),
      [201, 201],
      JSON.stringify(concurrent),
    )
    assert.equal(
      await client.v2ValidatedSegment.count({
        where: {
          workspaceId,
          projectId,
          physicalMaterialized: false,
          causalClaimAllowed: false,
        },
      }),
      4,
    )
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBefore,
    )
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.stack : String(error)}\n${serverLogs}`,
    )
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await once(server, 'exit').catch(() => undefined)
    }
    await client.$disconnect()
  }
})
