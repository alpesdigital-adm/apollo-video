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

test('T-FR-048/T-FR-136 catalogs, searches cross-project with structured Director channels, reranks and evaluates through public API and PostgreSQL', {
  skip:
    process.env.APOLLO_HYBRID_SEARCH_E2E !== '1' &&
    'set APOLLO_HYBRID_SEARCH_E2E=1 and use an isolated V2 database',
  timeout: 180_000,
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
    await import(
      '../../src/v2/infrastructure/security/api-credential.ts'
    )

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `hybrid-e2e-workspace-${suffix}`
  const projectId = `hybrid-e2e-project-${suffix}`
  const crossProjectId = `hybrid-e2e-cross-project-${suffix}`
  const createdAt = new Date('2026-07-27T17:30:00.000Z')
  const artifacts = {
    proof: {
      id: `hybrid-proof-image-${suffix}`,
      sha256: 'a'.repeat(64),
      mediaType: 'image',
      container: 'png',
    },
    testimonial: {
      id: `hybrid-testimonial-video-${suffix}`,
      sha256: 'b'.repeat(64),
      mediaType: 'video',
      container: 'mp4',
    },
    blocked: {
      id: `hybrid-blocked-image-${suffix}`,
      sha256: 'c'.repeat(64),
      mediaType: 'image',
      container: 'jpg',
    },
    cross: {
      id: `hybrid-cross-image-${suffix}`,
      sha256: 'd'.repeat(64),
      mediaType: 'image',
      container: 'png',
    },
  }
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
        name: 'Hybrid search E2E',
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
      id: `hybrid-e2e-client-${suffix}`,
      workspaceId,
      name: 'Hybrid search E2E',
      environment: 'sandbox',
      scopes: ['projects:read', 'projects:write', 'clients:admin'],
    })
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Hybrid retrieval fixture',
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
    await client.v2Project.create({
      data: {
        id: crossProjectId,
        workspaceId,
        name: 'Cross-project retrieval fixture',
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

    for (const [role, artifact] of Object.entries(artifacts)) {
      await client.v2MediaArtifact.create({
        data: {
          id: artifact.id,
          workspaceId,
          artifactKey:
            `workspaces/${workspaceId}/sources/${artifact.id}.${artifact.container}`,
          sha256: artifact.sha256,
          byteSize: BigInt(250_000),
          mediaType: artifact.mediaType,
          container: artifact.container,
          status: 'available',
          createdAt,
        },
      })
      await client.v2ProjectMediaAsset.create({
        data: {
          id: randomUUID(),
          workspaceId,
          projectId: role === 'cross'
            ? crossProjectId
            : projectId,
          artifactId: artifact.id,
          role: 'source-master',
          originalFileName: `${role}.${artifact.container}`,
          createdAt,
        },
      })
    }

    const testimonialManifest = createMediaArtifactManifestV2({
      artifactKey:
        `workspaces/${workspaceId}/sources/${artifacts.testimonial.id}.mp4`,
      artifactSha256: artifacts.testimonial.sha256,
      byteSize: 250_000,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'controlled-hybrid-search-e2e',
        version: '1.0.0',
        parameters: { fixture: 'testimonial' },
      },
      sources: [],
      probe: {
        width: 1080,
        height: 1920,
        duration: 90,
        fps: 30,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: `hybrid-testimonial-manifest-${suffix}`,
        workspaceId,
        artifactId: artifacts.testimonial.id,
        schemaVersion: testimonialManifest.schemaVersion,
        manifestHash: testimonialManifest.manifestHash,
        recipeId: testimonialManifest.recipe.id,
        recipeVersion: testimonialManifest.recipe.version,
        parametersHash:
          testimonialManifest.recipe.parametersHash,
        manifestJson: stableSerialize(testimonialManifest),
        createdAt,
      },
    })

    const rightsRepository =
      new PrismaAssetRightsRepository(client)
    for (const [role, artifact] of Object.entries(artifacts)) {
      await setAssetRightsService({
        repository: rightsRepository,
        clock: () => createdAt,
        createId: () => `hybrid-rights-${role}-${suffix}`,
      })({
        workspaceId,
        artifactId: artifact.id,
        baseRevision: assetRightsRevision(artifact.id, 0),
        draft: {
          status: role === 'blocked' ? 'restricted' : 'approved',
          allowedUses:
            role === 'blocked'
              ? ['rendering']
              : ['rendering', 'editorial-reuse'],
          prohibitedUses:
            role === 'blocked'
              ? ['editorial-reuse']
              : [],
          allowedLocales: ['pt-BR'],
          consent: {
            status: 'not-required',
            allowedUses: [],
          },
        },
        actor: {
          type: 'api-client',
          id: issued.client.id,
        },
      })
    }

    const artifactCountBefore =
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      })
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      [
        'node_modules/next/dist/bin/next',
        'start',
        '-p',
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'sandbox',
          APOLLO_SEMANTIC_EMBEDDING_PROVIDER: 'openai',
          OPENAI_API_KEY: 'must-never-be-used-by-sandbox',
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
    const catalogEndpoint =
      `${baseUrl}/v1/projects/${projectId}/semantic-search/documents`
    const queryEndpoint =
      `${baseUrl}/v1/projects/${projectId}/semantic-search/query`
    const crossCatalogEndpoint =
      `${baseUrl}/v1/projects/${crossProjectId}/semantic-search/documents`
    const reuseRunEndpoint =
      `${baseUrl}/v1/projects/${projectId}/semantic-search/reuse-runs`
    const evaluationEndpoint =
      `${baseUrl}/v1/projects/${projectId}/semantic-search/evaluations`
    const scaleEvaluationEndpoint =
      `${baseUrl}/v1/projects/${projectId}/semantic-search/scale-evaluations`
    const producer = {
      provider: 'apollo',
      model: 'hybrid-search-e2e',
      version: '1.0.0',
      confidence: 0.99,
    }
    const proofBody = {
      source: {
        type: 'artifact',
        id: artifacts.proof.id,
      },
      expectedSourceHash: artifacts.proof.sha256,
      indexVersion: 'semantic-search-index/v1',
      observations: {
        ocrText: 'Custo por lead caiu 31 por cento',
        description:
          'Captura de tela com resultado comprovado da campanha.',
        intentions: ['proof', 'lead-generation'],
        personIds: ['person-specialist'],
        metadata: {
          atmosphere: 'confiante',
          campaign: 'captacao',
        },
        producer,
      },
    }
    const proofKey = `hybrid-proof-${suffix}`
    const proofResponse = await fetch(catalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': proofKey,
      },
      body: JSON.stringify(proofBody),
    })
    const proofPayload = await proofResponse.json()
    assert.equal(
      proofResponse.status,
      201,
      JSON.stringify(proofPayload),
    )
    assert.equal(proofPayload.data.replayed, false)
    const firstProof = proofPayload.data.document
    assert.equal(firstProof.embedding.state, 'ready')
    assert.equal(firstProof.embedding.dimensions, 256)
    assert.equal(firstProof.physicalMaterialized, false)
    assert.equal('searchTextNormalized' in firstProof, false)
    assert.equal('requestFingerprint' in firstProof, false)
    assert.equal('idempotencyKey' in firstProof, false)

    const replayResponse = await fetch(catalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': proofKey,
      },
      body: JSON.stringify(proofBody),
    })
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200)
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(
      replayPayload.data.document.id,
      firstProof.id,
    )

    const mismatchResponse = await fetch(catalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': proofKey,
      },
      body: JSON.stringify({
        ...proofBody,
        observations: {
          ...proofBody.observations,
          description: 'Payload diferente.',
        },
      }),
    })
    assert.equal(mismatchResponse.status, 409)

    const staleResponse = await fetch(catalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `hybrid-stale-${suffix}`,
      },
      body: JSON.stringify({
        ...proofBody,
        expectedSourceHash: 'f'.repeat(64),
      }),
    })
    const stalePayload = await staleResponse.json()
    assert.equal(staleResponse.status, 409)
    assert.equal(stalePayload.error.code, 'VERSION_CONFLICT')

    const testimonialBody = {
      source: {
        type: 'artifact',
        id: artifacts.testimonial.id,
      },
      expectedSourceHash: artifacts.testimonial.sha256,
      indexVersion: 'semantic-search-index/v1',
      observations: {
        description:
          'Depoimento de cliente relatando aumento de vendas.',
        intentions: ['testimonial', 'proof'],
        personIds: ['person-customer'],
        metadata: {
          atmosphere: 'emocional',
          campaign: 'vendas',
        },
        producer,
      },
    }
    const testimonialKey = `hybrid-testimonial-${suffix}`
    const concurrent = await Promise.all(
      [0, 1].map(() =>
        fetch(catalogEndpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': testimonialKey,
          },
          body: JSON.stringify(testimonialBody),
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
      concurrentPayloads[0].data.document.id,
      concurrentPayloads[1].data.document.id,
    )

    const blockedBody = {
      source: {
        type: 'artifact',
        id: artifacts.blocked.id,
      },
      expectedSourceHash: artifacts.blocked.sha256,
      indexVersion: 'semantic-search-index/v1',
      observations: {
        ocrText: 'Material bloqueado para reutilizacao editorial',
        description: 'Peça de referência sem licença editorial.',
        intentions: ['reference'],
        metadata: { campaign: 'restrita' },
        producer,
      },
    }
    const blockedResponse = await fetch(catalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `hybrid-blocked-${suffix}`,
      },
      body: JSON.stringify(blockedBody),
    })
    assert.equal(blockedResponse.status, 201)

    const crossResponse = await fetch(crossCatalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `hybrid-cross-${suffix}`,
      },
      body: JSON.stringify({
        source: {
          type: 'artifact',
          id: artifacts.cross.id,
        },
        expectedSourceHash: artifacts.cross.sha256,
        indexVersion: 'semantic-search-index/v1',
        observations: {
          ocrText: 'Receita recorrente cresceu no projeto vizinho',
          description:
            'Gráfico autorizado de receita recorrente cross-project.',
          intentions: ['proof', 'workspace-reuse'],
          personIds: ['person-cross-project'],
          metadata: {
            atmosphere: 'confiante',
            campaign: 'cross-project',
          },
          producer,
        },
      }),
    })
    const crossPayload = await crossResponse.json()
    assert.equal(
      crossResponse.status,
      201,
      JSON.stringify(crossPayload),
    )

    const reindexResponse = await fetch(catalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `hybrid-proof-reindex-${suffix}`,
      },
      body: JSON.stringify({
        ...proofBody,
        observations: {
          ...proofBody.observations,
          description:
            'Captura atualizada com resultado comprovado da campanha.',
        },
      }),
    })
    const reindexPayload = await reindexResponse.json()
    assert.equal(
      reindexResponse.status,
      201,
      JSON.stringify(reindexPayload),
    )
    const activeProof = reindexPayload.data.document
    assert.notEqual(activeProof.id, firstProof.id)
    assert.equal(
      await client.v2SemanticSearchDocument.count({
        where: {
          workspaceId,
          projectId,
          identityKey: `artifact:${artifacts.proof.id}`,
        },
      }),
      2,
    )
    assert.equal(
      await client.v2SemanticSearchDocument.count({
        where: {
          workspaceId,
          projectId,
          identityKey: `artifact:${artifacts.proof.id}`,
          active: true,
        },
      }),
      1,
    )

    const proofQuery = {
      text: 'custo por lead',
      intention: 'proof',
      rightsUse: 'editorial-reuse',
      filters: {
        kinds: ['image'],
        personIds: ['person-specialist'],
        maxDurationMs: 5000,
        locale: 'pt-BR',
        metadata: { campaign: 'captacao' },
        rights: 'approved',
      },
      includeBlocked: false,
      limit: 20,
      explain: true,
    }
    const searchResponse = await fetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(proofQuery),
    })
    const searchPayload = await searchResponse.json()
    assert.equal(
      searchResponse.status,
      200,
      JSON.stringify(searchPayload),
    )
    assert.equal(searchPayload.data.semantic.state, 'ready')
    assert.equal(
      searchPayload.data.rerankPolicyVersion,
      'hybrid-rerank/v1',
    )
    assert.equal(searchPayload.data.results.length, 1)
    const proofResult = searchPayload.data.results[0]
    assert.equal(proofResult.document.id, activeProof.id)
    assert.equal(
      proofResult.document.identityKey,
      `artifact:${artifacts.proof.id}`,
    )
    assert.equal(proofResult.eligibleForReuse, true)
    assert.deepEqual(proofResult.blockedReasons, [])
    assert.ok(
      proofResult.matchedBy.includes('full-text:ocr'),
    )
    assert.ok(
      proofResult.matchedBy.includes(
        'vector:intention-description',
      ),
    )
    assert.ok(
      proofResult.matchedBy.includes('structured:metadata'),
    )
    assert.ok(proofResult.matchedBy.includes('rights:allowed'))
    assert.equal('searchTextNormalized' in proofResult.document, false)
    assert.equal('requestFingerprint' in proofResult.document, false)

    const crossQuery = {
      intention: 'workspace-reuse',
      atmosphere: 'confiante',
      personIds: ['person-cross-project'],
      visual: 'gráfico autorizado',
      rightsUse: 'editorial-reuse',
      includeBlocked: false,
      limit: 20,
      explain: true,
    }
    const projectOnlyCrossResponse = await fetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(crossQuery),
    })
    const projectOnlyCrossPayload =
      await projectOnlyCrossResponse.json()
    assert.equal(projectOnlyCrossResponse.status, 200)
    assert.equal(
      projectOnlyCrossPayload.data.query.scope,
      'project',
    )
    assert.equal(projectOnlyCrossPayload.data.results.length, 0)

    const workspaceCrossResponse = await fetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...crossQuery,
        scope: 'workspace',
      }),
    })
    const workspaceCrossPayload =
      await workspaceCrossResponse.json()
    assert.equal(
      workspaceCrossResponse.status,
      200,
      JSON.stringify(workspaceCrossPayload),
    )
    assert.equal(
      workspaceCrossPayload.data.query.scope,
      'workspace',
    )
    const crossResult = workspaceCrossPayload.data.results.find(
      (result) =>
        result.document.identityKey ===
        `artifact:${artifacts.cross.id}`,
    )
    assert.ok(crossResult)
    assert.equal(
      crossResult.document.projectId,
      crossProjectId,
    )
    assert.ok(
      workspaceCrossPayload.data.results.every(
        (result) => result.eligibleForReuse,
      ),
    )
    assert.ok(
      workspaceCrossPayload.data.results.every(
        (result) =>
          result.document.identityKey !==
          `artifact:${artifacts.blocked.id}`,
      ),
    )

    const eligibleCrossIdentities =
      workspaceCrossPayload.data.results
        .filter((result) => result.eligibleForReuse)
        .map((result) => result.document.identityKey)
    const reuseBody = {
      query: {
        ...crossQuery,
        scope: 'workspace',
      },
      expectedQueryHash: workspaceCrossPayload.data.queryHash,
      expectedResultSetHash:
        workspaceCrossPayload.data.resultSetHash,
      reusedIdentityKeys: [`artifact:${artifacts.cross.id}`],
      directorRejections: eligibleCrossIdentities
        .filter((identityKey) =>
          identityKey !== `artifact:${artifacts.cross.id}`)
        .map((identityKey) => ({
          identityKey,
          reason: 'not-needed',
        })),
    }
    const reuseKey = `hybrid-reuse-${suffix}`
    const reuseResponse = await fetch(reuseRunEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': reuseKey,
      },
      body: JSON.stringify(reuseBody),
    })
    const reusePayload = await reuseResponse.json()
    assert.equal(
      reuseResponse.status,
      201,
      JSON.stringify(reusePayload),
    )
    assert.equal(reusePayload.data.replayed, false)
    assert.deepEqual(
      reusePayload.data.run.reusedIdentityKeys,
      [`artifact:${artifacts.cross.id}`],
    )
    assert.ok(
      reusePayload.data.run.candidateAudit.some(
        (candidate) =>
          candidate.identityKey ===
            `artifact:${artifacts.blocked.id}` &&
          candidate.rejectionReasons.includes(
            'RIGHTS_RESTRICTED',
          ),
      ),
    )
    assert.equal(
      await client.v2SemanticReuseRun.count({
        where: { workspaceId, projectId },
      }),
      1,
    )
    const reuseReplay = await fetch(reuseRunEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': reuseKey,
      },
      body: JSON.stringify(reuseBody),
    })
    const reuseReplayPayload = await reuseReplay.json()
    assert.equal(reuseReplay.status, 200)
    assert.equal(reuseReplayPayload.data.replayed, true)
    assert.equal(
      reuseReplayPayload.data.run.id,
      reusePayload.data.run.id,
    )

    const blockedQuery = {
      text: 'material bloqueado',
      rightsUse: 'editorial-reuse',
      filters: { rights: 'any' },
      includeBlocked: true,
      limit: 20,
      explain: true,
    }
    const blockedSearchResponse = await fetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(blockedQuery),
    })
    const blockedSearchPayload =
      await blockedSearchResponse.json()
    assert.equal(
      blockedSearchResponse.status,
      200,
      JSON.stringify(blockedSearchPayload),
    )
    const blockedResult =
      blockedSearchPayload.data.results.find(
        (result) =>
          result.document.identityKey ===
          `artifact:${artifacts.blocked.id}`,
      )
    assert.ok(blockedResult)
    assert.equal(blockedResult.eligibleForReuse, false)
    assert.ok(
      blockedResult.blockedReasons.includes('RIGHTS_RESTRICTED'),
    )
    assert.ok(
      blockedResult.blockedReasons.includes(
        'RIGHTS_USE_PROHIBITED',
      ),
    )

    const hiddenBlockedResponse = await fetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...blockedQuery,
        includeBlocked: false,
      }),
    })
    const hiddenBlockedPayload =
      await hiddenBlockedResponse.json()
    assert.equal(hiddenBlockedResponse.status, 200)
    assert.equal(
      hiddenBlockedPayload.data.results.length,
      0,
      JSON.stringify(hiddenBlockedPayload.data.results),
    )

    const evaluationBody = {
      k: 1,
      cases: [
        {
          id: 'case-proof-image',
          query: {
            text: 'custo por lead',
            intention: 'proof',
            rightsUse: 'editorial-reuse',
            filters: {
              kinds: ['image'],
              metadata: { campaign: 'captacao' },
              rights: 'approved',
            },
            includeBlocked: false,
          },
          relevantIdentityKeys: [
            `artifact:${artifacts.proof.id}`,
          ],
        },
        {
          id: 'case-testimonial-video',
          query: {
            text: 'depoimento aumento vendas',
            intention: 'testimonial',
            rightsUse: 'editorial-reuse',
            filters: {
              kinds: ['video'],
              minDurationMs: 60_000,
              maxDurationMs: 100_000,
              locale: 'pt-BR',
              rights: 'approved',
            },
            includeBlocked: false,
          },
          relevantIdentityKeys: [
            `artifact:${artifacts.testimonial.id}`,
          ],
        },
      ],
    }
    const evaluationKey = `hybrid-evaluation-${suffix}`
    const evaluationResponse = await fetch(evaluationEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': evaluationKey,
      },
      body: JSON.stringify(evaluationBody),
    })
    const evaluationPayload = await evaluationResponse.json()
    assert.equal(
      evaluationResponse.status,
      201,
      JSON.stringify(evaluationPayload),
    )
    assert.equal(evaluationPayload.data.replayed, false)
    const evaluation = evaluationPayload.data.evaluation
    assert.equal(evaluation.policyVersion, 'retrieval-eval/v1')
    assert.equal(
      evaluation.rerankPolicyVersion,
      'hybrid-rerank/v1',
    )
    assert.equal(evaluation.cases.length, 2)
    assert.equal(evaluation.aggregate.precisionAtK, 1)
    assert.equal(evaluation.aggregate.recallAtK, 1)
    assert.equal(evaluation.aggregate.ndcgAtK, 1)
    assert.equal(evaluation.aggregate.reciprocalRank, 1)
    assert.equal('requestFingerprint' in evaluation, false)
    assert.equal('idempotencyKey' in evaluation, false)

    const evaluationReplay = await fetch(evaluationEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': evaluationKey,
      },
      body: JSON.stringify(evaluationBody),
    })
    const evaluationReplayPayload =
      await evaluationReplay.json()
    assert.equal(evaluationReplay.status, 200)
    assert.equal(evaluationReplayPayload.data.replayed, true)
    assert.equal(
      evaluationReplayPayload.data.evaluation.id,
      evaluation.id,
    )

    const evaluationMismatch = await fetch(evaluationEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': evaluationKey,
      },
      body: JSON.stringify({ ...evaluationBody, k: 2 }),
    })
    assert.equal(evaluationMismatch.status, 409)

    const scaleEvaluationBody = {
      scope: 'workspace',
      k: 1,
      cases: [
        ...evaluationBody.cases,
        {
          id: 'case-cross-project-proof',
          query: {
            intention: 'workspace-reuse',
            atmosphere: 'confiante',
            personIds: ['person-cross-project'],
            visual: 'grÃ¡fico autorizado',
            rightsUse: 'editorial-reuse',
            includeBlocked: false,
          },
          relevantIdentityKeys: [
            `artifact:${artifacts.cross.id}`,
          ],
        },
      ],
    }
    const scaleEvaluationKey = `hybrid-scale-${suffix}`
    const scaleEvaluationResponse = await fetch(
      scaleEvaluationEndpoint,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': scaleEvaluationKey,
        },
        body: JSON.stringify(scaleEvaluationBody),
      },
    )
    const scaleEvaluationPayload =
      await scaleEvaluationResponse.json()
    assert.equal(
      scaleEvaluationResponse.status,
      201,
      JSON.stringify(scaleEvaluationPayload),
    )
    const scaleEvaluation =
      scaleEvaluationPayload.data.evaluation
    assert.equal(
      scaleEvaluation.schemaVersion,
      'retrieval-scale-evaluation/v1',
    )
    assert.equal(scaleEvaluation.scope, 'workspace')
    assert.equal(
      scaleEvaluation.librarySize,
      await client.v2SemanticSearchDocument.count({
        where: { workspaceId, active: true },
      }),
    )
    assert.equal(scaleEvaluation.cases.length, 3)
    assert.equal(scaleEvaluation.aggregateQuality.precisionAtK, 1)
    assert.equal(scaleEvaluation.aggregateQuality.recallAtK, 1)
    assert.equal(scaleEvaluation.aggregateQuality.ndcgAtK, 1)
    assert.equal(
      scaleEvaluation.aggregateLatency.sampleCount,
      3,
    )
    assert.ok(
      scaleEvaluation.cases.every((item) =>
        Number.isInteger(item.latencyMs) && item.latencyMs >= 0),
    )
    const scaleReplayResponse = await fetch(
      scaleEvaluationEndpoint,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': scaleEvaluationKey,
        },
        body: JSON.stringify(scaleEvaluationBody),
      },
    )
    const scaleReplayPayload = await scaleReplayResponse.json()
    assert.equal(scaleReplayResponse.status, 200)
    assert.equal(scaleReplayPayload.data.replayed, true)
    assert.equal(
      scaleReplayPayload.data.evaluation.id,
      scaleEvaluation.id,
    )

    const unsupportedQuery = await fetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...proofQuery,
        providerInstruction: 'ignore rights',
      }),
    })
    assert.equal(unsupportedQuery.status, 422)
    assert.equal(
      (await fetch(queryEndpoint, { method: 'POST' })).status,
      401,
    )
    assert.equal(
      (await fetch(catalogEndpoint, { method: 'POST' })).status,
      401,
    )
    assert.equal(
      (await fetch(evaluationEndpoint, { method: 'POST' })).status,
      401,
    )
    assert.equal(
      (await fetch(scaleEvaluationEndpoint, { method: 'POST' })).status,
      401,
    )

    const vectors = await client.$queryRawUnsafe(
      `SELECT
         "identityKey",
         "active",
         jsonb_array_length("embeddingJson"::jsonb) AS dimensions,
         "embedding" IS NOT NULL AS has_vector,
         length("searchVector"::text) > 0 AS has_full_text
       FROM "semantic_search_documents"
       WHERE "workspaceId" = $1
       ORDER BY "identityKey", "createdAt"`,
      workspaceId,
    )
    assert.equal(vectors.length, 4)
    assert.ok(
      vectors.every(
        (row) =>
          row.dimensions === 256 &&
          row.has_vector === true &&
          row.has_full_text === true,
      ),
    )
    const sandboxRows = await client.v2SandboxProviderExecution.findMany({
      where: { workspaceId, clientId: issued.client.id },
      orderBy: { createdAt: 'desc' },
    })
    assert.ok(sandboxRows.length >= 10)
    assert.ok(sandboxRows.every((row) =>
      row.environment === 'sandbox' &&
      row.provider === 'apollo-sandbox-fake' &&
      row.operation === 'semantic-embedding' &&
      row.externalCalls === 0 && row.costMinorUnits > 0))
    const sandboxAuditResponse = await fetch(
      `${baseUrl}/v1/governance/sandbox-executions?limit=5`,
      { headers: { authorization } },
    )
    const sandboxAuditPayload = await sandboxAuditResponse.json()
    assert.equal(sandboxAuditResponse.status, 200)
    assert.equal(sandboxAuditPayload.data.entries.length, 5)
    assert.ok(sandboxAuditPayload.data.entries.every((entry) =>
      entry.externalCalls === 0 && entry.input === undefined))
    assert.ok(sandboxAuditPayload.data.nextCursor)
    assert.equal(
      await client.v2RetrievalEvaluation.count({
        where: { workspaceId, projectId },
      }),
      1,
    )
    assert.equal(
      await client.v2RetrievalScaleEvaluation.count({
        where: { workspaceId, projectId },
      }),
      1,
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      }),
      artifactCountBefore,
    )
    await assert.rejects(
      client.v2SemanticSearchDocument.update({
        where: { id: activeProof.id },
        data: { physicalMaterialized: true },
      }),
      /semantic_search_documents_policy_check/,
    )
    await assert.rejects(
      client.v2SemanticSearchDocument.update({
        where: { id: activeProof.id },
        data: { embeddingDimensions: 128 },
      }),
      /semantic_search_documents_embedding_check/,
    )

    await setAssetRightsService({
      repository: rightsRepository,
      clock: () => new Date(createdAt.getTime() + 1_000),
      createId: () => `hybrid-rights-proof-rotated-${suffix}`,
    })({
      workspaceId,
      artifactId: artifacts.proof.id,
      baseRevision: assetRightsRevision(artifacts.proof.id, 1),
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
      actor: {
        type: 'api-client',
        id: issued.client.id,
      },
    })
    const staleRightsResponse = await fetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...proofQuery,
        filters: {
          ...proofQuery.filters,
          rights: 'any',
        },
        includeBlocked: true,
      }),
    })
    const staleRightsPayload = await staleRightsResponse.json()
    assert.equal(staleRightsResponse.status, 200)
    const staleProof =
      staleRightsPayload.data.results.find(
        (result) =>
          result.document.identityKey ===
          `artifact:${artifacts.proof.id}`,
      )
    assert.ok(staleProof)
    assert.equal(
      staleProof.eligibleForReuse,
      false,
    )
    assert.ok(
      staleProof.blockedReasons.includes(
        'RIGHTS_SNAPSHOT_STALE',
      ),
    )
    assert.ok(
      staleProof.blockedReasons.includes(
        'RIGHTS_USE_NOT_ALLOWED',
      ),
    )
  } catch (error) {
    if (serverLogs) {
      process.stderr.write(`\n--- Next server log ---\n${serverLogs}\n`)
    }
    throw error
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    await client.$disconnect()
  }
})
