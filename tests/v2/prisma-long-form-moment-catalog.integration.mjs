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

test('T-FR-045 catalogs and searches a hierarchical two-hour live through the public API and PostgreSQL', {
  skip:
    process.env.APOLLO_LONG_FORM_E2E !== '1' &&
    'set APOLLO_LONG_FORM_E2E=1 and use an isolated V2 database',
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
  const workspaceId = `long-form-e2e-workspace-${suffix}`
  const projectId = `long-form-e2e-project-${suffix}`
  const artifactId = `long-form-e2e-artifact-${suffix}`
  const manifestId = `long-form-e2e-manifest-${suffix}`
  const createdAt = new Date('2026-07-27T14:30:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Long-form moment catalog E2E',
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
      id: `long-form-e2e-client-${suffix}`,
      workspaceId,
      name: 'Long-form moment catalog E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Live de duas horas E2E',
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

    const artifactKey =
      `workspaces/${workspaceId}/masters/${artifactId}.mp4`
    const artifactSha256 = 'b'.repeat(64)
    const manifest = createMediaArtifactManifestV2({
      artifactKey,
      artifactSha256,
      byteSize: 2_000_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'controlled-long-form-e2e',
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
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey,
        sha256: artifactSha256,
        byteSize: BigInt(2_000_000),
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
        originalFileName: 'live-duas-horas.mp4',
        createdAt,
      },
    })
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => createdAt,
      createId: () => `long-form-e2e-rights-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
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

    const authorization = `Bearer ${issued.token}`
    const endpoint =
      `${baseUrl}/v1/projects/${projectId}/long-form-moments`
    const body = {
      sourceArtifactId: artifactId,
      expectedArtifactSha256: artifactSha256,
      sourceManifestId: manifestId,
      expectedManifestHash: manifest.manifestHash,
      indexPolicyVersion: 'long-form-index/v1',
      producer: {
        provider: 'apollo',
        model: 'long-form-director',
        version: '1.0.0',
        confidence: 0.96,
      },
      chapters: [
        {
          sourceChapterId: 'chapter-acquisition',
          title: {
            value: 'Fundamentos de aquisição',
            confidence: 0.95,
          },
          topicPath: ['marketing', 'aquisição'],
          rangeMs: [0, 3_600_000],
        },
        {
          sourceChapterId: 'chapter-conversion',
          title: {
            value: 'Conversão e oferta',
            confidence: 0.97,
          },
          topicPath: ['marketing', 'conversão'],
          rangeMs: [3_600_000, 7_200_000],
        },
      ],
      moments: [
        {
          sourceMomentId: 'moment-traffic',
          sourceChapterId: 'chapter-acquisition',
          topic: {
            value: 'Gestão de tráfego',
            confidence: 0.94,
          },
          summary: {
            value: 'Explica como validar criativos antes de escalar.',
            confidence: 0.93,
          },
          keyQuote: {
            value: 'Escala sem validação amplia o desperdício.',
            confidence: 0.91,
          },
          speakerIds: ['person-specialist'],
          rangesMs: [[120_000, 150_000]],
          recommendedRangeIndex: 0,
          evidenceSpanIds: ['speech-segment-traffic'],
          salience: 0.88,
          hookPotential: 0.82,
          standaloneScore: 0.9,
          contextScore: 0.86,
          insightDensity: 0.87,
          roles: ['educação'],
          tags: ['aquisição', 'tráfego'],
        },
        {
          sourceMomentId: 'moment-offer',
          sourceChapterId: 'chapter-conversion',
          topic: {
            value: 'Construção de oferta',
            confidence: 0.98,
          },
          summary: {
            value: 'Demonstra como tornar a oferta específica e acionável.',
            confidence: 0.97,
          },
          keyQuote: {
            value: 'Uma oferta clara reduz a fricção da decisão.',
            confidence: 0.96,
          },
          speakerIds: ['person-specialist'],
          rangesMs: [
            [4_000_000, 4_030_000],
            [4_100_000, 4_120_000],
          ],
          recommendedRangeIndex: 0,
          evidenceSpanIds: [
            'speech-segment-offer-a',
            'speech-segment-offer-b',
          ],
          salience: 0.97,
          hookPotential: 0.92,
          standaloneScore: 0.95,
          contextScore: 0.93,
          insightDensity: 0.96,
          roles: ['cta'],
          tags: ['conversão', 'oferta'],
        },
      ],
    }
    const key = `long-form-catalog-${suffix}`
    const catalogResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    })
    const catalogPayload = await catalogResponse.json()
    assert.equal(
      catalogResponse.status,
      201,
      JSON.stringify(catalogPayload),
    )
    assert.equal(catalogPayload.data.replayed, false)
    const run = catalogPayload.data.run
    assert.equal(run.durationMs, 7_200_000)
    assert.equal(run.chapterCount, 2)
    assert.equal(run.momentCount, 2)
    assert.equal('summary' in run, false)
    assert.equal('requestFingerprint' in run, false)
    assert.equal('idempotencyKey' in run, false)
    assert.match(run.hierarchyHash, /^[a-f0-9]{64}$/)
    assert.match(run.recordHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(
      run.chapters.map((chapter) => chapter.momentIds.length),
      [1, 1],
    )
    assert.ok(
      run.chapters.every(
        (chapter) =>
          chapter.physicalMaterialized === false &&
          /^[a-f0-9]{64}$/.test(chapter.chapterHash),
      ),
    )
    assert.ok(
      run.moments.every(
        (moment) =>
          moment.physicalMaterialized === false &&
          /^[a-f0-9]{64}$/.test(moment.momentHash) &&
          moment.topic.provenance.source === 'long-form-analysis' &&
          moment.summary.provenance.provider === 'apollo',
      ),
    )

    const replayResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    })
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.run.id, run.id)

    const mismatchResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({
        ...body,
        producer: { ...body.producer, confidence: 0.8 },
      }),
    })
    assert.equal(mismatchResponse.status, 409)

    const staleSourceResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `long-form-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...body,
        expectedArtifactSha256: 'f'.repeat(64),
      }),
    })
    const staleSourcePayload = await staleSourceResponse.json()
    assert.equal(staleSourceResponse.status, 409)
    assert.equal(staleSourcePayload.error.code, 'VERSION_CONFLICT')

    const searchUrl = new URL(endpoint)
    searchUrl.searchParams.set('q', 'OFERTA')
    searchUrl.searchParams.set('speakerId', 'person-specialist')
    searchUrl.searchParams.set('role', 'CTA')
    searchUrl.searchParams.set('tag', 'CONVERSÃO')
    searchUrl.searchParams.set('minSalience', '0.9')
    searchUrl.searchParams.set('contextBeforeMs', '10000')
    searchUrl.searchParams.set('contextAfterMs', '10000')
    const searchResponse = await fetch(searchUrl, {
      headers: { authorization },
    })
    const searchPayload = await searchResponse.json()
    assert.equal(searchResponse.status, 200, JSON.stringify(searchPayload))
    assert.equal(searchPayload.data.results.length, 1)
    const result = searchPayload.data.results[0]
    assert.equal(result.moment.sourceMomentId, 'moment-offer')
    assert.equal(result.chapter.sourceChapterId, 'chapter-conversion')
    assert.deepEqual(result.matchedBy, [
      'text',
      'speaker',
      'role',
      'tag',
      'salience',
    ])
    assert.deepEqual(
      result.preview.primary.sourceRangeMs,
      [4_000_000, 4_030_000],
    )
    assert.deepEqual(
      result.preview.primary.previewRangeMs,
      [3_990_000, 4_040_000],
    )
    assert.equal(result.preview.ranges.length, 2)
    assert.equal(result.eligibleForReuse, true)
    assert.deepEqual(result.blockedReasons, [])

    const partialRoleUrl = new URL(endpoint)
    partialRoleUrl.searchParams.set('role', 'ta')
    const partialRoleResponse = await fetch(partialRoleUrl, {
      headers: { authorization },
    })
    const partialRolePayload = await partialRoleResponse.json()
    assert.equal(partialRoleResponse.status, 200)
    assert.deepEqual(partialRolePayload.data.results, [])

    const unauthenticated = await fetch(endpoint)
    assert.equal(unauthenticated.status, 401)

    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBefore,
      'hierarchical indexing must not create physical media artifacts',
    )
    assert.equal(
      await client.v2LongFormIndexRun.count({
        where: { workspaceId, projectId },
      }),
      1,
    )
    assert.equal(
      await client.v2LongFormChapter.count({
        where: {
          workspaceId,
          projectId,
          physicalMaterialized: false,
        },
      }),
      2,
    )
    assert.equal(
      await client.v2LongFormMoment.count({
        where: {
          workspaceId,
          projectId,
          physicalMaterialized: false,
        },
      }),
      2,
    )
    await assert.rejects(
      client.v2LongFormMoment.update({
        where: { id: result.moment.id },
        data: { physicalMaterialized: true },
      }),
      /long_form_moments_virtual_range_check/,
    )

    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => new Date(createdAt.getTime() + 1_000),
      createId: () => `long-form-e2e-rights-rotated-${suffix}`,
    })({
      workspaceId,
      artifactId,
      baseRevision: assetRightsRevision(artifactId, 1),
      draft: {
        status: 'approved',
        allowedUses: ['rendering'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: {
          status: 'not-required',
          allowedUses: [],
        },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })
    const staleRightsResponse = await fetch(searchUrl, {
      headers: { authorization },
    })
    const staleRightsPayload = await staleRightsResponse.json()
    assert.equal(staleRightsResponse.status, 200)
    assert.equal(
      staleRightsPayload.data.results[0].eligibleForReuse,
      false,
    )
    assert.deepEqual(
      staleRightsPayload.data.results[0].blockedReasons,
      ['RIGHTS_SNAPSHOT_STALE'],
    )

    const concurrentResponses = await Promise.all(
      ['a', 'b'].map(async (label, index) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key':
              `long-form-concurrent-${label}-${suffix}`,
          },
          body: JSON.stringify({
            ...body,
            producer: {
              ...body.producer,
              confidence: 0.94 + index * 0.01,
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
      concurrentResponses.map((response) => response.status),
      [201, 201],
      JSON.stringify(concurrentResponses),
    )
    const persistedRuns = await client.v2LongFormIndexRun.findMany({
      where: { workspaceId, projectId },
    })
    assert.equal(persistedRuns.length, 3)
    assert.equal(
      persistedRuns.filter((persisted) => persisted.active).length,
      1,
      'serializable re-indexing must leave exactly one active hierarchy',
    )
    assert.equal(
      await client.v2LongFormChapter.count({
        where: { workspaceId, projectId, physicalMaterialized: false },
      }),
      6,
      're-indexing must preserve immutable virtual chapter history',
    )
    assert.equal(
      await client.v2LongFormMoment.count({
        where: { workspaceId, projectId, physicalMaterialized: false },
      }),
      6,
      're-indexing must preserve immutable virtual moment history',
    )
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      artifactCountBefore,
      'concurrent re-indexing must not create physical artifacts',
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
