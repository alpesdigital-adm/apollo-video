import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateRetrievalMetrics,
  calculateRetrievalMetrics,
  catalogSemanticSearchDocument,
  rerankHybridSearch,
  semanticRightsRejectionReasons,
  semanticEmbeddingInput,
} from '../../src/v2/domain/hybrid-search.ts'
import {
  hybridSearchService,
} from '../../src/v2/application/hybrid-search.ts'
import {
  parseHybridSearchQueryBody,
} from '../../src/v2/public-api/hybrid-search-contract.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  DeterministicSemanticEmbeddingProvider,
  OpenAISemanticEmbeddingProvider,
  createSemanticEmbeddingProvider,
} from '../../src/v2/infrastructure/semantic-embedding-provider.ts'

const createdAt = '2026-07-27T17:00:00.000Z'

function context(overrides = {}) {
  return {
    source: {
      type: 'speech-segment',
      id: 'speech-campaign-result',
      hash: 'a'.repeat(64),
      artifactId: 'artifact-campaign-result',
      artifactSha256: 'b'.repeat(64),
    },
    kind: 'speech-segment',
    durationMs: 6_000,
    locale: 'pt-BR',
    personIds: ['person-specialist'],
    transcriptText:
      'Este resultado de campanha reduziu o custo por lead.',
    intentions: ['proof', 'performance'],
    description: 'Especialista apresenta um gráfico limpo.',
    metadata: {
      atmosphere: 'confiante',
      orientation: 'portrait',
    },
    rights: {
      id: 'rights-campaign-result',
      status: 'approved',
      consentStatus: 'not-required',
      allowedUses: ['editorial-reuse'],
      prohibitedUses: [],
    },
    ...overrides,
  }
}

function document({
  id = 'semantic-document-campaign-result',
  source = context(),
  ocrText = 'CPL -31%',
  description = 'Dashboard com evolução positiva',
  intentions = ['lead-generation'],
  people = [],
  metadata = { color: 'blue' },
  embeddingState = 'ready',
} = {}) {
  const embeddingInput = semanticEmbeddingInput({
    transcriptText: source.transcriptText,
    ocrText,
    intentions: [...source.intentions, ...intentions],
    description: [source.description, description].join('\n'),
    metadata: { ...metadata, ...source.metadata },
  })
  return catalogSemanticSearchDocument({
    id,
    workspaceId: 'workspace-semantic',
    projectId: 'project-semantic',
    context: source,
    expectedSourceHash: source.source.hash,
    observations: {
      ocrText,
      description,
      intentions,
      personIds: people,
      metadata,
      producer: {
        provider: 'apollo',
        model: 'semantic-observer',
        version: '1.0.0',
        confidence: 0.96,
      },
    },
    embedding: {
      state: embeddingState,
      provider: 'controlled',
      model: 'semantic-vector',
      version: '1.0.0',
      dimensions: 256,
      degraded: false,
      inputHash: calculateCanonicalHash(embeddingInput),
      ...(embeddingState === 'ready'
        ? { vectorHash: 'c'.repeat(64) }
        : {}),
    },
    actor: { type: 'api-client', id: 'client-semantic' },
    createdAt,
  })
}

test('T-FR-048 catalogs transcript, OCR, intention, description and structured metadata with immutable provenance', () => {
  const item = document()
  assert.equal(item.source.type, 'speech-segment')
  assert.equal(item.ocrText, 'CPL -31%')
  assert.deepEqual(item.personIds, ['person-specialist'])
  assert.deepEqual(item.intentions, [
    'proof',
    'performance',
    'lead-generation',
  ])
  assert.equal(item.metadata.atmosphere, 'confiante')
  assert.equal(item.metadata.color, 'blue')
  assert.equal(item.embedding.state, 'ready')
  assert.equal(item.physicalMaterialized, false)
  assert.match(item.documentHash, /^[a-f0-9]{64}$/)
  assert.ok(Object.isFrozen(item))
  assert.ok(Object.isFrozen(item.metadata))
  assert.ok(Object.isFrozen(item.embedding))
})

test('T-FR-048 applies hard filters, rights gates and explains every match or block', () => {
  const approved = document()
  const blockedContext = context({
    source: {
      type: 'artifact',
      id: 'artifact-beach',
      hash: 'd'.repeat(64),
      artifactId: 'artifact-beach',
      artifactSha256: 'd'.repeat(64),
    },
    kind: 'video',
    durationMs: 2_000,
    locale: 'en-US',
    personIds: ['person-other'],
    transcriptText: 'A beach lifestyle scene.',
    intentions: ['lifestyle'],
    description: 'Beach at sunset.',
    metadata: { atmosphere: 'relaxed' },
    rights: {
      id: 'rights-beach',
      status: 'restricted',
      consentStatus: 'unknown',
      allowedUses: [],
      prohibitedUses: ['editorial-reuse'],
    },
  })
  const blocked = document({
    id: 'semantic-document-beach',
    source: blockedContext,
    ocrText: '',
    description: '',
    intentions: [],
    metadata: {},
  })
  const query = {
    text: 'resultado CPL dashboard',
    intention: 'proof performance',
    rightsUse: 'editorial-reuse',
    filters: {
      kinds: ['speech-segment'],
      personIds: ['person-specialist'],
      minDurationMs: 3_000,
      maxDurationMs: 10_000,
      locale: 'pt-BR',
      metadata: { atmosphere: 'confiante' },
      rights: 'approved',
    },
    includeBlocked: true,
    limit: 10,
    explain: true,
  }
  const results = rerankHybridSearch({
    candidates: [
      {
        document: approved,
        currentRights: context().rights,
        fullTextScore: 0.91,
        vectorScore: 0.95,
      },
      {
        document: blocked,
        currentRights: blockedContext.rights,
        fullTextScore: 0.25,
        vectorScore: 0.1,
      },
    ],
    query,
    now: createdAt,
  })
  assert.equal(results[0].document.id, approved.id)
  assert.equal(results[0].eligibleForReuse, true)
  assert.ok(results[0].matchedBy.includes('full-text:transcript'))
  assert.ok(results[0].matchedBy.includes('full-text:ocr'))
  assert.ok(results[0].matchedBy.includes('vector:intention-description'))
  assert.ok(results[0].matchedBy.includes('structured:metadata'))
  assert.ok(results[0].matchedBy.includes('rights:allowed'))
  assert.equal(results[1].eligibleForReuse, false)
  assert.ok(results[1].blockedReasons.includes('RIGHTS_RESTRICTED'))
  assert.ok(
    results[1].blockedReasons.includes('RIGHTS_USE_PROHIBITED'),
  )
  assert.ok(
    results[1].blockedReasons.includes('FILTER_KIND_MISMATCH'),
  )
  assert.ok(
    results[1].blockedReasons.includes('FILTER_LOCALE_MISMATCH'),
  )
})

test('T-FR-048 deduplicates source identity and reranks with hybrid-rerank/v1', () => {
  const old = document({
    id: 'semantic-document-old',
  })
  const newer = document({
    id: 'semantic-document-new',
  })
  const results = rerankHybridSearch({
    candidates: [
      {
        document: old,
        currentRights: context().rights,
        fullTextScore: 0.4,
        vectorScore: 0.4,
      },
      {
        document: {
          ...newer,
          createdAt: '2026-07-27T17:01:00.000Z',
        },
        currentRights: context().rights,
        fullTextScore: 0.9,
        vectorScore: 0.95,
      },
    ],
    query: {
      text: 'resultado',
      intention: 'proof',
      rightsUse: 'editorial-reuse',
      includeBlocked: false,
      limit: 10,
      explain: true,
    },
    now: '2026-07-27T17:02:00.000Z',
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].document.id, newer.id)
  assert.equal(results[0].rerankPolicyVersion, 'hybrid-rerank/v1')
  assert.ok(results[0].score > 0.8)
})

test('T-FR-048 excludes candidates with no lexical, intention or meaningful vector signal', () => {
  const results = rerankHybridSearch({
    candidates: [{
      document: document(),
      currentRights: context().rights,
      fullTextScore: 0.1,
      vectorScore: 0.12,
    }],
    query: {
      text: 'praia mediterranea',
      rightsUse: 'editorial-reuse',
      includeBlocked: false,
      limit: 10,
      explain: true,
    },
    now: createdAt,
  })
  assert.deepEqual(results, [])
})

test('T-FR-048 calculates precision, recall and nDCG per query and macro evaluation', () => {
  const excellent = calculateRetrievalMetrics({
    rankedIdentityKeys: [
      'speech-segment:speech-campaign-result',
      'artifact:artifact-beach',
    ],
    relevantIdentityKeys: [
      'speech-segment:speech-campaign-result',
    ],
    k: 2,
  })
  const partial = calculateRetrievalMetrics({
    rankedIdentityKeys: [
      'artifact:artifact-beach',
      'speech-segment:speech-campaign-result',
    ],
    relevantIdentityKeys: [
      'speech-segment:speech-campaign-result',
      'artifact:artifact-missing',
    ],
    k: 2,
  })
  assert.equal(excellent.precisionAtK, 0.5)
  assert.equal(excellent.recallAtK, 1)
  assert.equal(excellent.ndcgAtK, 1)
  assert.equal(excellent.reciprocalRank, 1)
  assert.ok(partial.ndcgAtK > 0 && partial.ndcgAtK < 1)
  const macro = aggregateRetrievalMetrics([excellent, partial])
  assert.equal(macro.k, 2)
  assert.ok(macro.precisionAtK > 0)
  assert.ok(macro.recallAtK < 1)
  assert.ok(macro.ndcgAtK < 1)
})

test('T-FR-048 keeps full-text available when embedding is unavailable', () => {
  const unavailable = document({ embeddingState: 'unavailable' })
  const results = rerankHybridSearch({
    candidates: [{
      document: unavailable,
      currentRights: context().rights,
      fullTextScore: 0.88,
      vectorScore: 0,
    }],
    query: {
      text: 'resultado campanha',
      rightsUse: 'editorial-reuse',
      includeBlocked: false,
      limit: 5,
      explain: true,
    },
    now: createdAt,
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].eligibleForReuse, true)
  assert.equal(results[0].scoreBreakdown.vector, 0)
  assert.ok(results[0].matchedBy.includes('full-text:transcript'))
  assert.ok(
    !results[0].matchedBy.includes(
      'vector:intention-description',
    ),
  )
})

test('T-FR-136 preserves workspace scope in the public contract and forwards one evaluation instant to candidate selection', async () => {
  const parsed = parseHybridSearchQueryBody({
    scope: 'workspace',
    text: 'resultado campanha',
    rightsUse: 'editorial-reuse',
  })
  let captured
  const crossProject = {
    ...document(),
    id: 'semantic-document-cross-project',
    projectId: 'project-other',
    identityKey: 'speech-segment:speech-cross-project',
  }
  const search = hybridSearchService({
    repository: {
      async searchCandidates(query) {
        captured = query
        return [{
          document: crossProject,
          currentRights: context().rights,
          fullTextScore: 0.9,
          vectorScore: 0.9,
        }]
      },
    },
    embeddingProvider:
      new DeterministicSemanticEmbeddingProvider(),
    clock: () => new Date(createdAt),
  })
  const response = await search({
    workspaceId: 'workspace-semantic',
    projectId: 'project-semantic',
    ...parsed,
  })
  assert.equal(captured.query.scope, 'workspace')
  assert.equal(captured.evaluatedAt, createdAt)
  assert.equal(captured.workspaceId, 'workspace-semantic')
  assert.equal(response.query.scope, 'workspace')
  assert.equal(response.results[0].document.projectId, 'project-other')
})

test('T-FR-136 defaults to project scope and forbids exposing rights-blocked workspace candidates', async () => {
  let calls = 0
  const search = hybridSearchService({
    repository: {
      async searchCandidates() {
        calls += 1
        return []
      },
    },
    embeddingProvider:
      new DeterministicSemanticEmbeddingProvider(),
    clock: () => new Date(createdAt),
  })
  const projectResponse = await search({
    workspaceId: 'workspace-semantic',
    projectId: 'project-semantic',
    text: 'resultado',
    rightsUse: 'editorial-reuse',
  })
  assert.equal(projectResponse.query.scope, 'project')
  await assert.rejects(
    search({
      workspaceId: 'workspace-semantic',
      projectId: 'project-semantic',
      scope: 'workspace',
      text: 'resultado',
      rightsUse: 'editorial-reuse',
      includeBlocked: true,
    }),
    /Workspace search cannot include rights-blocked candidates/,
  )
  await assert.rejects(
    search({
      workspaceId: 'workspace-semantic',
      projectId: 'project-semantic',
      scope: 'workspace',
      filters: { rights: 'blocked' },
      rightsUse: 'editorial-reuse',
    }),
    /Workspace search cannot request rights-blocked candidates/,
  )
  await assert.rejects(
    search({
      workspaceId: 'workspace-semantic',
      projectId: 'project-semantic',
      scope: 'organization',
      text: 'resultado',
      rightsUse: 'editorial-reuse',
    }),
    /scope must be project or workspace/,
  )
  assert.equal(calls, 1)
})

test('T-FR-136 applies current rights, consent, use and expiry before workspace rerank', () => {
  const item = document()
  assert.deepEqual(
    semanticRightsRejectionReasons({
      document: item,
      current: {
        ...context().rights,
        consentStatus: 'revoked',
        allowedUses: [],
        prohibitedUses: ['editorial-reuse'],
        expiresAt: createdAt,
      },
      rightsUse: 'editorial-reuse',
      now: createdAt,
    }),
    [
      'RIGHTS_EXPIRED',
      'CONSENT_REVOKED',
      'RIGHTS_USE_PROHIBITED',
      'RIGHTS_USE_NOT_ALLOWED',
    ],
  )
})

test('T-FR-048 OpenAI adapter sends a bounded 256-dimensional request and validates the vector', async () => {
  let captured
  const vector = Array.from({ length: 256 }, (_, index) =>
    index === 0 ? 2 : 0)
  const provider = new OpenAISemanticEmbeddingProvider(
    'controlled-api-key',
    async (url, init) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({ data: [{ embedding: vector }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  )
  const result = await provider.embed('prova de campanha')
  assert.equal(
    captured.url,
    'https://api.openai.com/v1/embeddings',
  )
  assert.equal(
    captured.init.headers.authorization,
    'Bearer controlled-api-key',
  )
  assert.deepEqual(JSON.parse(captured.init.body), {
    model: 'text-embedding-3-small',
    input: 'prova de campanha',
    dimensions: 256,
    encoding_format: 'float',
  })
  assert.equal(result.length, 256)
  assert.equal(result[0], 1)
  assert.equal(
    Math.sqrt(
      result.reduce((sum, value) => sum + value * value, 0),
    ),
    1,
  )
})

test('T-FR-048 deterministic E2E adapter is stable and normalized', async () => {
  const provider = new DeterministicSemanticEmbeddingProvider()
  const first = await provider.embed('prova de campanha')
  const replay = await provider.embed('prova de campanha')
  assert.deepEqual(first, replay)
  assert.equal(first.length, 256)
  assert.ok(Object.isFrozen(first))
  assert.ok(
    Math.abs(
      Math.sqrt(
        first.reduce(
          (sum, value) => sum + value * value,
          0,
        ),
      ) - 1,
    ) < 1e-12,
  )
})

test('T-FR-048 embedding configuration fails closed in production and permits deterministic vectors only for isolated E2E', () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.V2_DATABASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
    selected: process.env.APOLLO_SEMANTIC_EMBEDDING_PROVIDER,
  }
  try {
    process.env.NODE_ENV = 'production'
    process.env.V2_DATABASE_URL =
      'postgresql://example:example@localhost:5432/apollo_video_v2'
    delete process.env.OPENAI_API_KEY
    delete process.env.APOLLO_SEMANTIC_EMBEDDING_PROVIDER
    assert.throws(
      () => createSemanticEmbeddingProvider(),
      /OPENAI_API_KEY is required/,
    )
    process.env.V2_DATABASE_URL =
      'postgresql://example:example@localhost:5432/apollo_video_v2_e2e_search'
    process.env.APOLLO_SEMANTIC_EMBEDDING_PROVIDER =
      'deterministic'
    assert.ok(
      createSemanticEmbeddingProvider() instanceof
        DeterministicSemanticEmbeddingProvider,
    )
  } finally {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    restore('NODE_ENV', previous.nodeEnv)
    restore('V2_DATABASE_URL', previous.databaseUrl)
    restore('OPENAI_API_KEY', previous.apiKey)
    restore(
      'APOLLO_SEMANTIC_EMBEDDING_PROVIDER',
      previous.selected,
    )
  }
})
