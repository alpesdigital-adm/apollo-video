import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const BASE_ACTIVE_DOCUMENTS = 4
// Every corpus write — asset rights and document catalog alike — commits in a
// SERIALIZABLE transaction that scans small tables, so concurrent seeders
// serialize against each other and exhaust the adapters' internal retries
// (observed as PERSISTENCE_CONFLICT from PrismaAssetRightsRepository.setCurrent
// while four seeders provisioned four *distinct* artifacts). The corpus is a
// fixture, not the behaviour under measurement: seed it in a single ordered
// stream so the library is byte-for-byte reproducible and no run depends on
// how PostgreSQL resolves a self-inflicted read/write dependency cycle.
const CORPUS_SEED_CONCURRENCY = 1
const CORPUS_TIERS = [10, 100, 1000]
const CORPUS_NEEDLES = 4
const CORPUS_INTENTIONS = [
  'proof',
  'testimonial',
  'reference',
  'workspace-reuse',
  'lead-generation',
]
const CORPUS_ATMOSPHERES = [
  'confiante',
  'emocional',
  'analitico',
  'urgente',
  'sereno',
]
const CORPUS_WORDS = [
  'faturamento',
  'retencao',
  'audiencia',
  'conversao',
  'recorrencia',
  'atendimento',
  'logistica',
  'treinamento',
  'operacao',
  'margem',
]

// `project_media_assets.id` is a native `@db.Uuid` column, so the corpus
// cannot label those rows with a readable identifier. Derive an RFC 4122
// name-based UUID from the corpus seed instead, keeping the fixture
// reproducible across runs without hard-coding literals.
function deterministicUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * Legitimate client behaviour against the real governance limiter: `/v1`
 * denies authenticated bursts with 429 `GOVERNANCE_LIMIT_EXCEEDED` once
 * `evaluateGovernanceAnomalies` sees more than `requestMinimum` requests in
 * its 60 s signal window. Seeding a 1.000-document corpus is a long, honest
 * burst, so the harness waits the limiter out instead of relaxing it. Denied
 * admissions are persisted and keep counting inside the window, so the
 * backoff is real waiting.
 */
const RATE_LIMIT_BACKOFF_MS = Object.freeze([
  3_000, 8_000, 15_000, 30_000, 45_000, 60_000,
])

async function apiFetch(input, init) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await globalThis.fetch(input, init)
    if (response.status !== 429) return response
    const payload = await response.clone().json().catch(() => null)
    assert.equal(
      payload?.error?.code,
      'GOVERNANCE_LIMIT_EXCEEDED',
      `unexpected 429 payload: ${JSON.stringify(payload)}`,
    )
    assert.equal(payload?.error?.category, 'quota')
    assert.equal(payload?.error?.retryable, true)
    if (attempt >= RATE_LIMIT_BACKOFF_MS.length) {
      throw new Error(
        `governance limiter did not clear after ${attempt} retries: ` +
          JSON.stringify(payload),
      )
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(60_000, Math.ceil(retryAfter) * 1_000)
      : RATE_LIMIT_BACKOFF_MS[attempt]
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const current = cursor
        cursor += 1
        results[current] = await worker(items[current], current)
      }
    },
  )
  await Promise.all(runners)
  return results
}

async function readCorpusSnapshot(client, workspaceId) {
  const rows = await client.$queryRawUnsafe(
    `SELECT "identityKey", "documentHash", "embeddingInputHash"
       FROM "semantic_search_documents"
      WHERE "workspaceId" = $1 AND "active" = true
      ORDER BY "identityKey"`,
    workspaceId,
  )
  const digest = createHash('sha256')
  for (const row of rows) {
    digest.update(
      `${row.identityKey}|${row.documentHash}|${row.embeddingInputHash}\n`,
    )
  }
  return Object.freeze({
    size: rows.length,
    digest: digest.digest('hex'),
  })
}

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
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next server exited with ${child.exitCode}`)
    }
    try {
      if ((await globalThis.fetch(`${baseUrl}/v1/health`)).ok) return
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
  timeout: 1_500_000,
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
  const { SEMANTIC_DIRECTOR_REJECTION_REASONS } =
    await import('../../src/v2/application/hybrid-search.ts')
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

    const foreignWorkspaceId = `hybrid-e2e-foreign-ws-${suffix}`
    const foreignProjectId = `hybrid-e2e-foreign-project-${suffix}`
    const foreignArtifact = {
      id: `hybrid-foreign-image-${suffix}`,
      sha256: 'e'.repeat(64),
    }
    await client.v2Workspace.create({
      data: {
        id: foreignWorkspaceId,
        slug: foreignWorkspaceId,
        name: 'Hybrid search foreign workspace',
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      },
    })
    const foreignIssued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `hybrid-e2e-foreign-client-${suffix}`,
      workspaceId: foreignWorkspaceId,
      name: 'Hybrid search foreign workspace',
      environment: 'sandbox',
      scopes: ['projects:read', 'projects:write', 'clients:admin'],
    })
    await client.v2Project.create({
      data: {
        id: foreignProjectId,
        workspaceId: foreignWorkspaceId,
        name: 'Foreign workspace retrieval fixture',
        status: 'draft',
        objective: 'lead-generation',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: foreignIssued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: foreignArtifact.id,
        workspaceId: foreignWorkspaceId,
        artifactKey:
          `workspaces/${foreignWorkspaceId}/sources/${foreignArtifact.id}.png`,
        sha256: foreignArtifact.sha256,
        byteSize: BigInt(250_000),
        mediaType: 'image',
        container: 'png',
        status: 'available',
        createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId: foreignWorkspaceId,
        projectId: foreignProjectId,
        artifactId: foreignArtifact.id,
        role: 'source-master',
        originalFileName: 'foreign.png',
        createdAt,
      },
    })
    await setAssetRightsService({
      repository: rightsRepository,
      clock: () => createdAt,
      createId: () => `hybrid-rights-foreign-${suffix}`,
    })({
      workspaceId: foreignWorkspaceId,
      artifactId: foreignArtifact.id,
      baseRevision: assetRightsRevision(foreignArtifact.id, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: { status: 'not-required', allowedUses: [] },
      },
      actor: {
        type: 'api-client',
        id: foreignIssued.client.id,
      },
    })

    const artifactCountBefore =
      await client.v2MediaArtifact.count({
        where: { workspaceId },
      })
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const serverMode =
      process.env.APOLLO_E2E_SERVER_MODE === 'dev' ? 'dev' : 'start'
    server = spawn(
      process.execPath,
      [
        'node_modules/next/dist/bin/next',
        serverMode,
        ...(serverMode === 'dev' ? ['--webpack'] : []),
        '-p',
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: serverMode === 'dev' ? 'development' : 'production',
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
    const proofResponse = await apiFetch(catalogEndpoint, {
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

    const replayResponse = await apiFetch(catalogEndpoint, {
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

    const mismatchResponse = await apiFetch(catalogEndpoint, {
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

    const staleResponse = await apiFetch(catalogEndpoint, {
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
        apiFetch(catalogEndpoint, {
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
    const blockedResponse = await apiFetch(catalogEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `hybrid-blocked-${suffix}`,
      },
      body: JSON.stringify(blockedBody),
    })
    assert.equal(blockedResponse.status, 201)

    const crossResponse = await apiFetch(crossCatalogEndpoint, {
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

    const foreignCatalogResponse = await apiFetch(
      `${baseUrl}/v1/projects/${foreignProjectId}` +
        '/semantic-search/documents',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${foreignIssued.token}`,
          'content-type': 'application/json',
          'idempotency-key': `hybrid-foreign-${suffix}`,
        },
        body: JSON.stringify({
          source: {
            type: 'artifact',
            id: foreignArtifact.id,
          },
          expectedSourceHash: foreignArtifact.sha256,
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
      },
    )
    const foreignCatalogPayload = await foreignCatalogResponse.json()
    assert.equal(
      foreignCatalogResponse.status,
      201,
      JSON.stringify(foreignCatalogPayload),
    )
    assert.equal(
      await client.v2SemanticSearchDocument.count({
        where: {
          workspaceId: foreignWorkspaceId,
          active: true,
          identityKey: `artifact:${foreignArtifact.id}`,
        },
      }),
      1,
      'foreign workspace candidate must exist and be active',
    )

    const reindexResponse = await apiFetch(catalogEndpoint, {
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
    const searchResponse = await apiFetch(queryEndpoint, {
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
    const projectOnlyCrossResponse = await apiFetch(queryEndpoint, {
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

    const workspaceCrossResponse = await apiFetch(queryEndpoint, {
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
    assert.ok(
      workspaceCrossPayload.data.results.every(
        (result) =>
          result.document.identityKey !==
          `artifact:${foreignArtifact.id}`,
      ),
      'workspace scope must never surface another workspace',
    )
    assert.ok(
      workspaceCrossPayload.data.results.every(
        (result) =>
          result.document.projectId === projectId ||
          result.document.projectId === crossProjectId,
      ),
      'workspace scope must stay inside the anchor workspace projects',
    )
    const foreignQueryResponse = await apiFetch(
      `${baseUrl}/v1/projects/${foreignProjectId}/semantic-search/query`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...crossQuery, scope: 'workspace' }),
      },
    )
    assert.equal(
      foreignQueryResponse.status,
      404,
      'anchor project of another workspace must not authorize the query',
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
    const reuseResponse = await apiFetch(reuseRunEndpoint, {
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
    const reuseReplay = await apiFetch(reuseRunEndpoint, {
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
    const blockedSearchResponse = await apiFetch(queryEndpoint, {
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

    const hiddenBlockedResponse = await apiFetch(queryEndpoint, {
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
    const evaluationResponse = await apiFetch(evaluationEndpoint, {
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

    const evaluationReplay = await apiFetch(evaluationEndpoint, {
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

    const evaluationMismatch = await apiFetch(evaluationEndpoint, {
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
    const scaleEvaluationResponse = await apiFetch(
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
    const scaleReplayResponse = await apiFetch(
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

    const unsupportedQuery = await apiFetch(queryEndpoint, {
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
      (await apiFetch(queryEndpoint, { method: 'POST' })).status,
      401,
    )
    assert.equal(
      (await apiFetch(catalogEndpoint, { method: 'POST' })).status,
      401,
    )
    assert.equal(
      (await apiFetch(evaluationEndpoint, { method: 'POST' })).status,
      401,
    )
    assert.equal(
      (await apiFetch(scaleEvaluationEndpoint, { method: 'POST' })).status,
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
    const vectorSummary = JSON.stringify(
      vectors.map((row) => ({
        identityKey: row.identityKey,
        active: row.active,
        dimensions: Number(row.dimensions),
        hasVector: row.has_vector,
        hasFullText: row.has_full_text,
      })),
    )
    assert.equal(
      vectors.length,
      5,
      `four identities plus the superseded proof revision: ${vectorSummary}`,
    )
    assert.equal(
      vectors.filter((row) => row.active === true).length,
      BASE_ACTIVE_DOCUMENTS,
      `exactly one active revision per identity: ${vectorSummary}`,
    )
    assert.ok(
      vectors.every(
        (row) =>
          Number(row.dimensions) === 256 &&
          row.has_vector === true &&
          row.has_full_text === true,
      ),
      `every persisted revision must stay indexed: ${vectorSummary}`,
    )
    const sandboxRows = await client.v2SandboxProviderExecution.findMany({
      where: { workspaceId, clientId: issued.client.id },
      orderBy: { createdAt: 'desc' },
    })
    assert.ok(
      sandboxRows.length >= 10,
      `sandbox executions recorded: ${sandboxRows.length}`,
    )
    assert.ok(
      sandboxRows.every((row) =>
        row.environment === 'sandbox' &&
        row.provider === 'apollo-sandbox-fake' &&
        row.operation === 'semantic-embedding' &&
        row.externalCalls === 0 && row.costMinorUnits > 0),
      `sandbox executions must never call outside: ${JSON.stringify(
        sandboxRows.slice(0, 3).map((row) => ({
          environment: row.environment,
          provider: row.provider,
          operation: row.operation,
          externalCalls: row.externalCalls,
          costMinorUnits: row.costMinorUnits,
        })),
      )}`,
    )
    const sandboxAuditResponse = await apiFetch(
      `${baseUrl}/v1/governance/sandbox-executions?limit=5`,
      { headers: { authorization } },
    )
    const sandboxAuditPayload = await sandboxAuditResponse.json()
    assert.equal(
      sandboxAuditResponse.status,
      200,
      JSON.stringify(sandboxAuditPayload),
    )
    assert.equal(
      sandboxAuditPayload.data.entries.length,
      5,
      `governance page must honour limit=5: ${JSON.stringify(
        sandboxAuditPayload.data,
      ).slice(0, 400)}`,
    )
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
    const staleRightsResponse = await apiFetch(queryEndpoint, {
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

    const corpusArtifactId = (index) =>
      `hybrid-corpus-${String(index).padStart(4, '0')}-${suffix}`
    const corpusSha256 = (index) =>
      createHash('sha256')
        .update(`hybrid-corpus:${suffix}:${index}`)
        .digest('hex')
    const corpusCampaign = (index) =>
      `corpus-${String(index).padStart(4, '0')}`
    const corpusNeedleToken = (index) =>
      `apolloneedle${String(index).padStart(4, '0')}`
    const corpusObservations = (index) => {
      const needle = index < CORPUS_NEEDLES
      const first = CORPUS_WORDS[index % CORPUS_WORDS.length]
      const second =
        CORPUS_WORDS[(index * 7 + 3) % CORPUS_WORDS.length]
      return {
        ocrText: needle
          ? `${corpusNeedleToken(index)} indicador de ${first}`
          : `Indicador de ${first} e ${second} no periodo`,
        description: needle
          ? `Painel exclusivo ${corpusNeedleToken(index)} de ${first}.`
          : `Painel de ${first} combinado com ${second} da campanha.`,
        intentions: [
          CORPUS_INTENTIONS[index % CORPUS_INTENTIONS.length],
        ],
        personIds: [`person-corpus-${index % 12}`],
        metadata: {
          atmosphere:
            CORPUS_ATMOSPHERES[index % CORPUS_ATMOSPHERES.length],
          campaign: corpusCampaign(index),
        },
        producer,
      }
    }

    async function provisionCorpusArtifacts(indexes) {
      await client.v2MediaArtifact.createMany({
        data: indexes.map((index) => ({
          id: corpusArtifactId(index),
          workspaceId,
          artifactKey:
            `workspaces/${workspaceId}/sources/` +
            `${corpusArtifactId(index)}.png`,
          sha256: corpusSha256(index),
          byteSize: BigInt(120_000),
          mediaType: 'image',
          container: 'png',
          status: 'available',
          createdAt,
        })),
      })
      await client.v2ProjectMediaAsset.createMany({
        data: indexes.map((index) => ({
          id: deterministicUuid(
            `project-media-asset:${suffix}:${index}`,
          ),
          workspaceId,
          projectId,
          artifactId: corpusArtifactId(index),
          role: 'source-master',
          originalFileName: `corpus-${index}.png`,
          createdAt,
        })),
      })
      await mapWithConcurrency(indexes, CORPUS_SEED_CONCURRENCY, async (index) => {
        await setAssetRightsService({
          repository: rightsRepository,
          clock: () => createdAt,
          createId: () => `hybrid-corpus-rights-${index}-${suffix}`,
        })({
          workspaceId,
          artifactId: corpusArtifactId(index),
          baseRevision: assetRightsRevision(corpusArtifactId(index), 0),
          draft: {
            status: 'approved',
            allowedUses: ['rendering', 'editorial-reuse'],
            prohibitedUses: [],
            allowedLocales: ['pt-BR'],
            consent: { status: 'not-required', allowedUses: [] },
          },
          actor: {
            type: 'api-client',
            id: issued.client.id,
          },
        })
      })
    }

    async function catalogCorpusDocument(index, observations) {
      const response = await apiFetch(catalogEndpoint, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `hybrid-corpus-${index}-${suffix}`,
        },
        body: JSON.stringify({
          source: { type: 'artifact', id: corpusArtifactId(index) },
          expectedSourceHash: corpusSha256(index),
          indexVersion: 'semantic-search-index/v1',
          observations: observations ?? corpusObservations(index),
        }),
      })
      if (response.status !== 201) {
        return `${index}:${response.status}:${await response.text()}`
      }
      await response.json()
      return null
    }

    async function seedCorpusUpTo(target, from) {
      const indexes = []
      for (let index = from; index < target; index += 1) {
        indexes.push(index)
      }
      await provisionCorpusArtifacts(indexes)
      const failures = (
        await mapWithConcurrency(
          indexes,
          CORPUS_SEED_CONCURRENCY,
          (index) => catalogCorpusDocument(index),
        )
      ).filter((entry) => entry !== null)
      assert.deepEqual(
        failures.slice(0, 3),
        [],
        'deterministic corpus seeding must catalog every document',
      )
      return target
    }

    const corpusCases = [
      ...Array.from({ length: CORPUS_NEEDLES }, (_, needle) => ({
        id: `corpus-needle-${needle}`,
        query: {
          text: corpusNeedleToken(needle),
          intention:
            CORPUS_INTENTIONS[needle % CORPUS_INTENTIONS.length],
          atmosphere:
            CORPUS_ATMOSPHERES[needle % CORPUS_ATMOSPHERES.length],
          personIds: [`person-corpus-${needle % 12}`],
          visual: corpusNeedleToken(needle),
          rightsUse: 'editorial-reuse',
          filters: {
            kinds: ['image'],
            locale: 'pt-BR',
            metadata: { campaign: corpusCampaign(needle) },
            rights: 'approved',
          },
          includeBlocked: false,
        },
        relevantIdentityKeys: [
          `artifact:${corpusArtifactId(needle)}`,
        ],
      })),
      {
        id: 'corpus-rights-blocked-negative',
        query: {
          text: 'material bloqueado reutilizacao editorial',
          rightsUse: 'editorial-reuse',
          filters: { rights: 'approved' },
          includeBlocked: false,
        },
        relevantIdentityKeys: [
          `artifact:${artifacts.blocked.id}`,
        ],
      },
    ]

    let seededCorpus = 0
    const tierDigests = []
    const tierLatencies = []
    for (const tier of CORPUS_TIERS) {
      seededCorpus = await seedCorpusUpTo(tier, seededCorpus)
      const before = await readCorpusSnapshot(client, workspaceId)
      assert.equal(
        before.size,
        BASE_ACTIVE_DOCUMENTS + tier,
        `tier ${tier} must be fully materialized in PostgreSQL`,
      )
      const tierResponse = await apiFetch(scaleEvaluationEndpoint, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `hybrid-corpus-scale-${tier}-${suffix}`,
        },
        body: JSON.stringify({
          scope: 'workspace',
          k: 1,
          cases: corpusCases,
        }),
      })
      const tierPayload = await tierResponse.json()
      assert.equal(
        tierResponse.status,
        201,
        JSON.stringify(tierPayload),
      )
      const tierReport = tierPayload.data.evaluation
      assert.equal(
        tierReport.schemaVersion,
        'retrieval-scale-evaluation/v1',
      )
      assert.equal(tierReport.scope, 'workspace')
      assert.equal(tierReport.k, 1)
      assert.equal(
        tierReport.librarySize,
        BASE_ACTIVE_DOCUMENTS + tier,
        `librarySize must be measured against PostgreSQL at tier ${tier}`,
      )
      assert.equal(tierReport.cases.length, corpusCases.length)
      for (let needle = 0; needle < CORPUS_NEEDLES; needle += 1) {
        const item = tierReport.cases[needle]
        assert.equal(item.id, `corpus-needle-${needle}`)
        assert.deepEqual(
          item.rankedIdentityKeys,
          [`artifact:${corpusArtifactId(needle)}`],
          `tier ${tier} needle ${needle} must isolate a single document`,
        )
        assert.equal(item.metrics.precisionAtK, 1)
        assert.equal(item.metrics.recallAtK, 1)
        assert.equal(item.metrics.ndcgAtK, 1)
        assert.equal(item.metrics.reciprocalRank, 1)
        assert.equal(item.semanticState, 'ready')
      }
      const negativeCase = tierReport.cases[CORPUS_NEEDLES]
      assert.equal(negativeCase.id, 'corpus-rights-blocked-negative')
      assert.equal(
        negativeCase.rankedIdentityKeys.includes(
          `artifact:${artifacts.blocked.id}`,
        ),
        false,
        'a rights-blocked document must never be ranked',
      )
      assert.equal(negativeCase.metrics.precisionAtK, 0)
      assert.equal(negativeCase.metrics.recallAtK, 0)
      assert.equal(negativeCase.metrics.ndcgAtK, 0)
      assert.equal(negativeCase.metrics.reciprocalRank, 0)
      for (const metric of [
        'precisionAtK',
        'recallAtK',
        'ndcgAtK',
        'reciprocalRank',
      ]) {
        assert.ok(
          Math.abs(tierReport.aggregateQuality[metric] - 0.8) < 1e-9,
          `tier ${tier} aggregate ${metric} must stay at 4/5`,
        )
      }
      const latency = tierReport.aggregateLatency
      assert.equal(latency.sampleCount, corpusCases.length)
      assert.ok(Number.isInteger(latency.minMs) && latency.minMs >= 0)
      assert.ok(latency.minMs <= latency.p50Ms)
      assert.ok(latency.p50Ms <= latency.p95Ms)
      assert.ok(latency.p95Ms <= latency.maxMs)
      assert.ok(Number.isInteger(latency.meanMs))
      tierLatencies.push({ tier, ...latency })

      const rankingResponse = await apiFetch(queryEndpoint, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text: corpusNeedleToken(0),
          scope: 'workspace',
          rightsUse: 'editorial-reuse',
          includeBlocked: false,
          limit: 20,
          explain: true,
        }),
      })
      const rankingPayload = await rankingResponse.json()
      assert.equal(
        rankingResponse.status,
        200,
        JSON.stringify(rankingPayload),
      )
      assert.ok(
        rankingPayload.data.results.length >= 1,
        `unfiltered needle query returned nothing at tier ${tier}`,
      )
      assert.equal(
        rankingPayload.data.results[0].document.identityKey,
        `artifact:${corpusArtifactId(0)}`,
        `unfiltered ranking must keep the needle first at tier ${tier}`,
      )

      const after = await readCorpusSnapshot(client, workspaceId)
      assert.equal(
        after.digest,
        before.digest,
        `corpus must stay immutable across tier ${tier} measurement`,
      )
      assert.equal(after.size, before.size)
      tierDigests.push(after.digest)
    }
    assert.equal(
      new Set(tierDigests).size,
      CORPUS_TIERS.length,
      'the corpus digest must change when the library grows',
    )
    assert.equal(
      await client.v2SemanticSearchDocument.count({
        where: { workspaceId, active: true },
      }),
      BASE_ACTIVE_DOCUMENTS + CORPUS_TIERS[CORPUS_TIERS.length - 1],
    )
    assert.equal(
      await client.v2RetrievalScaleEvaluation.count({
        where: { workspaceId, projectId },
      }),
      1 + CORPUS_TIERS.length,
      'one baseline plus one persisted report per corpus tier',
    )

    const spareBase = CORPUS_TIERS[CORPUS_TIERS.length - 1]
    const spareIndexes = Array.from(
      { length: 6 },
      (_, offset) => spareBase + offset,
    )
    await provisionCorpusArtifacts(spareIndexes)

    const driftCases = Array.from({ length: 40 }, (_, position) => ({
      ...corpusCases[position % CORPUS_NEEDLES],
      id: `corpus-drift-${position}`,
    }))
    let driftStatus = 0
    let driftCode = ''
    for (
      let attempt = 0;
      attempt < 3 && driftStatus !== 409;
      attempt += 1
    ) {
      const driftIndex = spareIndexes[attempt]
      const driftInFlight = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return catalogCorpusDocument(driftIndex)
      })()
      const driftResponse = await apiFetch(scaleEvaluationEndpoint, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key':
            `hybrid-corpus-drift-${attempt}-${suffix}`,
        },
        body: JSON.stringify({
          scope: 'workspace',
          k: 1,
          cases: driftCases,
        }),
      })
      const driftPayload = await driftResponse.json()
      assert.equal(await driftInFlight, null)
      driftStatus = driftResponse.status
      driftCode = driftPayload.error?.code ?? ''
    }
    assert.equal(
      driftStatus,
      409,
      'a corpus that drifts mid-measurement must fail closed',
    )
    assert.equal(
      driftCode,
      'VERSION_CONFLICT',
      `drift must be reported as a version conflict, got ${driftCode}`,
    )

    // Retrieval fetches `candidateLimit` rows ordered by score BEFORE any
    // structured filter is applied, so a fixture phrased in ordinary corpus
    // vocabulary loses its own documents to trigram similarity once the
    // library holds a thousand of them. Anchor this fixture on a rare token
    // the corpus never uses — the same recipe the corpus needles already
    // proved at 1.000 documents — and keep the campaign filter as the exact
    // isolation on top of it.
    const staleToken = 'apollostaleset'
    const staleCampaign = `stale-set-${suffix}`
    const staleObservations = (index) => ({
      ocrText: `${staleToken} conjunto instavel item ${index}`,
      description: `${staleToken} documento do conjunto instavel.`,
      intentions: ['reference'],
      personIds: ['person-stale-set'],
      metadata: { atmosphere: 'sereno', campaign: staleCampaign },
      producer,
    })
    const staleFirstIndex = spareIndexes[3]
    const staleSecondIndex = spareIndexes[4]
    assert.equal(
      await catalogCorpusDocument(
        staleFirstIndex,
        staleObservations(staleFirstIndex),
      ),
      null,
    )
    const staleQuery = {
      text: staleToken,
      scope: 'workspace',
      rightsUse: 'editorial-reuse',
      filters: {
        kinds: ['image'],
        metadata: { campaign: staleCampaign },
        rights: 'approved',
      },
      includeBlocked: false,
      limit: 20,
      explain: true,
    }
    const staleSetResponse = await apiFetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(staleQuery),
    })
    const staleSetPayload = await staleSetResponse.json()
    assert.equal(
      staleSetResponse.status,
      200,
      JSON.stringify(staleSetPayload),
    )
    // A candidate can be absent for two very different reasons: retrieval
    // never returned it, or a structured filter rejected it. Probe the
    // unfiltered query so the failure message says which one happened
    // instead of only reporting an empty list.
    const stalePresence = staleSetPayload.data.results.length === 1
      ? 'present'
      : await (async () => {
        const probe = await apiFetch(queryEndpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text: staleToken,
            scope: 'workspace',
            rightsUse: 'editorial-reuse',
            includeBlocked: true,
            limit: 20,
            explain: true,
          }),
        })
        const payload = await probe.json()
        const target = payload.data?.results?.find(
          (result) =>
            result.document.identityKey ===
            `artifact:${corpusArtifactId(staleFirstIndex)}`,
        )
        return JSON.stringify({
          unfilteredTop: payload.data?.results
            ?.slice(0, 5)
            .map((result) => result.document.identityKey),
          targetRetrieved: Boolean(target),
          targetBlockedReasons: target?.blockedReasons ?? null,
        })
      })()
    assert.equal(
      staleSetPayload.data.results.length,
      1,
      `stale fixture must start with one candidate: ${JSON.stringify(
        staleSetPayload.data.results.map(
          (result) => result.document.identityKey,
        ),
      )} unfiltered probe: ${stalePresence}`,
    )
    const staleResultSetHash = staleSetPayload.data.resultSetHash
    const staleQueryHash = staleSetPayload.data.queryHash
    assert.equal(
      await catalogCorpusDocument(
        staleSecondIndex,
        staleObservations(staleSecondIndex),
      ),
      null,
    )
    const staleReuseResponse = await apiFetch(reuseRunEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `hybrid-stale-set-${suffix}`,
      },
      body: JSON.stringify({
        query: staleQuery,
        expectedQueryHash: staleQueryHash,
        expectedResultSetHash: staleResultSetHash,
        reusedIdentityKeys: [
          `artifact:${corpusArtifactId(staleFirstIndex)}`,
        ],
        directorRejections: [],
      }),
    })
    const staleReusePayload = await staleReuseResponse.json()
    assert.equal(
      staleReuseResponse.status,
      409,
      JSON.stringify(staleReusePayload),
    )
    assert.equal(staleReusePayload.error.code, 'VERSION_CONFLICT')

    const auditQueryResponse = await apiFetch(queryEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(staleQuery),
    })
    const auditQueryPayload = await auditQueryResponse.json()
    assert.equal(
      auditQueryResponse.status,
      200,
      JSON.stringify(auditQueryPayload),
    )
    assert.equal(
      auditQueryPayload.data.results.length,
      2,
      `audit fixture must expose both candidates: ${JSON.stringify(
        auditQueryPayload.data.results.map(
          (result) => result.document.identityKey,
        ),
      )}`,
    )
    const auditReuseResponse = await apiFetch(reuseRunEndpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `hybrid-audit-set-${suffix}`,
      },
      body: JSON.stringify({
        query: staleQuery,
        expectedQueryHash: auditQueryPayload.data.queryHash,
        expectedResultSetHash: auditQueryPayload.data.resultSetHash,
        reusedIdentityKeys: [
          `artifact:${corpusArtifactId(staleFirstIndex)}`,
        ],
        directorRejections: [
          {
            identityKey: `artifact:${corpusArtifactId(staleSecondIndex)}`,
            reason: 'not-needed',
          },
        ],
      }),
    })
    const auditReusePayload = await auditReuseResponse.json()
    assert.equal(
      auditReuseResponse.status,
      201,
      JSON.stringify(auditReusePayload),
    )
    const auditedRun = auditReusePayload.data.run
    const auditedKeys = auditedRun.candidateAudit.map(
      (candidate) => candidate.identityKey,
    )
    // A candidate is a document revision, so uniqueness is keyed on
    // documentId; workspace scope may legitimately audit two documents that
    // share an identityKey (recorded with DUPLICATE_IDENTITY).
    const auditedDocumentIds = auditedRun.candidateAudit.map(
      (candidate) => candidate.documentId,
    )
    assert.equal(
      new Set(auditedDocumentIds).size,
      auditedDocumentIds.length,
      'candidate audit must not repeat a candidate',
    )
    for (const result of auditQueryPayload.data.results) {
      assert.ok(
        auditedKeys.includes(result.document.identityKey),
        `every returned candidate must be audited: ${result.document.identityKey}`,
      )
    }
    // The audit carries two independent axes and conflating them hides both.
    // `rejectionReasons`/`disposition` record why retrieval did or did not
    // hand a candidate to the Director (rank, rights, duplicate identity, no
    // signal); `reusedIdentityKeys`/`directorRejections` record the Director's
    // editorial verdict on the candidates that were handed over. Completeness
    // means: every candidate is accounted for on the axis that applies to it,
    // and nothing falls between them.
    const rejectedByDirector = new Map(
      auditedRun.directorRejections.map(
        (item) => [item.identityKey, item.reason],
      ),
    )
    let returnedInAudit = 0
    for (const candidate of auditedRun.candidateAudit) {
      const returned = candidate.rejectionReasons.length === 0
      assert.equal(
        candidate.disposition,
        returned ? 'returned' : 'rejected',
        `candidate ${candidate.identityKey} disposition must follow its reasons: ${JSON.stringify(candidate)}`,
      )
      const reused = auditedRun.reusedIdentityKeys.includes(
        candidate.identityKey,
      )
      const rejected = rejectedByDirector.has(candidate.identityKey)
      if (returned) {
        returnedInAudit += 1
        assert.equal(
          reused !== rejected,
          true,
          `returned candidate ${candidate.identityKey} must be reused xor editorially rejected: ${JSON.stringify(
            { reused, rejected },
          )}`,
        )
        if (rejected) {
          assert.ok(
            SEMANTIC_DIRECTOR_REJECTION_REASONS.includes(
              rejectedByDirector.get(candidate.identityKey),
            ),
            `editorial rejection of ${candidate.identityKey} must carry an enumerated reason: ${rejectedByDirector.get(candidate.identityKey)}`,
          )
        }
      } else {
        assert.equal(
          reused || rejected,
          false,
          `candidate ${candidate.identityKey} was never returned, so the Director cannot have decided on it`,
        )
      }
    }
    assert.equal(
      returnedInAudit,
      auditedRun.returnedIdentityKeys.length,
      'every returned identity must appear once in the candidate audit',
    )
    assert.equal(
      auditedRun.returnedIdentityKeys.length,
      auditedRun.reusedIdentityKeys.length +
        auditedRun.directorRejections.length,
      'reuse and rejection must partition the returned candidates',
    )
    assert.equal(
      auditedRun.candidateCount,
      auditedRun.candidateAudit.length,
      'candidateCount must match the persisted audit',
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

test('T-FR-136 UI, Director and agents share a single semantic search application service', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const roots = ['src', 'scripts']
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(path)
    }
  }
  for (const root of roots) await walk(root)

  const applicationConsumers = []
  const repositoryConsumers = []
  for (const path of files) {
    const source = await readFile(path, 'utf8')
    if (source.includes('application/hybrid-search')) {
      applicationConsumers.push(path)
    }
    if (
      source.includes('createSemanticSearchRepository') ||
      source.includes('PrismaSemanticSearchRepository')
    ) {
      repositoryConsumers.push(path)
    }
  }

  const publicRoutes = [
    'src/app/v1/director-tools/route.ts',
    'src/app/v1/projects/[projectId]/semantic-search/documents/route.ts',
    'src/app/v1/projects/[projectId]/semantic-search/evaluations/route.ts',
    'src/app/v1/projects/[projectId]/semantic-search/query/route.ts',
    'src/app/v1/projects/[projectId]/semantic-search/reuse-runs/route.ts',
    'src/app/v1/projects/[projectId]/semantic-search/scale-evaluations/route.ts',
  ]
  assert.deepEqual(
    applicationConsumers.sort(),
    [...publicRoutes].sort(),
    'only the public /v1 semantic-search routes and the Director tool route may compose the hybrid search application services',
  )
  const allowedRepositoryConsumers = [
    ...publicRoutes,
    'src/v2/infrastructure/prisma/semantic-search-repository.ts',
    'src/v2/infrastructure/repository-factory.ts',
  ]
  assert.deepEqual(
    repositoryConsumers.sort(),
    [...allowedRepositoryConsumers].sort(),
    'no parallel path may reach the semantic search repository',
  )
})
