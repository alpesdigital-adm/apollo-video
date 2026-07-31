import {
  calculateCanonicalHash,
} from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  aggregateRetrievalMetrics,
  calculateRetrievalMetrics,
  catalogSemanticSearchDocument,
  HYBRID_RERANK_POLICY_VERSION,
  HYBRID_SEARCH_KINDS,
  HYBRID_SEARCH_SCOPES,
  HYBRID_SEARCH_SOURCE_TYPES,
  rerankHybridSearch,
  RETRIEVAL_EVAL_POLICY_VERSION,
  SEMANTIC_SEARCH_INDEX_VERSION,
  type HybridSearchFilters,
  type HybridSearchRequest,
  type HybridSearchScope,
  type SemanticSearchObservationInput,
} from '../domain/hybrid-search.ts'
import { normalizeSpeechText } from '../domain/speech-segment-catalog.ts'
import type {
  SemanticEmbeddingProvider,
} from './ports/semantic-embedding-provider.ts'
import type {
  PersistedRetrievalEvaluation,
  PersistedSemanticSearchDocument,
  SemanticSearchRepository,
  SemanticSearchSourceRef,
} from './ports/semantic-search-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      SHA_256.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return value.trim().toLowerCase()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function canonicalNow(value: Date, field: string): string {
  assertDomain(
    value instanceof Date && !Number.isNaN(value.getTime()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.toISOString()
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function embeddingVector(
  vector: readonly number[],
  dimensions: number,
): readonly number[] {
  assertDomain(
    Array.isArray(vector) &&
      vector.length === dimensions &&
      vector.every((value) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= -1 &&
        value <= 1),
    'INVALID_ARGUMENT',
    'Semantic embedding provider returned an invalid vector',
  )
  return Object.freeze([...vector])
}

async function createEmbedding(
  provider: SemanticEmbeddingProvider,
  input: string,
): Promise<Readonly<{
  evidence: {
    state: 'ready' | 'unavailable'
    provider: string
    model: string
    version: string
    dimensions: number
    degraded: boolean
    inputHash: string
    vectorHash?: string
  }
  vector: readonly number[] | null
}>> {
  const inputHash = calculateCanonicalHash(input)
  try {
    const vector = embeddingVector(
      await provider.embed(input),
      provider.descriptor.dimensions,
    )
    return Object.freeze({
      evidence: Object.freeze({
        state: 'ready' as const,
        ...provider.descriptor,
        inputHash,
        vectorHash: calculateCanonicalHash(vector),
      }),
      vector,
    })
  } catch {
    return Object.freeze({
      evidence: Object.freeze({
        state: 'unavailable' as const,
        ...provider.descriptor,
        inputHash,
      }),
      vector: null,
    })
  }
}

export function catalogSemanticSearchDocumentService(dependencies: {
  repository: SemanticSearchRepository
  embeddingProvider: SemanticEmbeddingProvider
  clock: () => Date
  createId: () => string
}) {
  return async function catalog(request: {
    workspaceId: string
    projectId: string
    source: SemanticSearchSourceRef
    expectedSourceHash: string
    indexVersion: string
    observations: SemanticSearchObservationInput
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    assertDomain(
      typeof request.source === 'object' &&
        request.source !== null &&
        HYBRID_SEARCH_SOURCE_TYPES.includes(request.source.type),
      'INVALID_ARGUMENT',
      'source is invalid',
    )
    const source = Object.freeze({
      type: request.source.type,
      id: identity(request.source.id, 'source.id'),
    })
    const expectedSourceHash = hash(
      request.expectedSourceHash,
      'expectedSourceHash',
    )
    assertDomain(
      request.indexVersion === SEMANTIC_SEARCH_INDEX_VERSION,
      'INVALID_ARGUMENT',
      `indexVersion must be ${SEMANTIC_SEARCH_INDEX_VERSION}`,
    )
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'Semantic indexing requires an authenticated API client',
    )
    const actorId = identity(request.actor.id, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'catalog-semantic-search-document-request/v1',
      workspaceId,
      projectId,
      source,
      expectedSourceHash,
      indexVersion: SEMANTIC_SEARCH_INDEX_VERSION,
      observations: request.observations,
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.repository.findIdempotentDocument({
      workspaceId,
      projectId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different semantic document request',
        )
      }
      return Object.freeze({ document: replay, replayed: true })
    }
    const context = await dependencies.repository.readSourceContext({
      workspaceId,
      projectId,
      source,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Semantic search source was not found',
      )
    }
    if (context.source.hash !== expectedSourceHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Semantic source changed before indexing',
        { currentSourceHash: context.source.hash },
      )
    }
    const id = identity(
      dependencies.createId(),
      'semanticDocumentId',
    )
    const createdAt = canonicalNow(
      dependencies.clock(),
      'semantic indexing clock',
    )
    const preliminary = catalogSemanticSearchDocument({
      id,
      workspaceId,
      projectId,
      context,
      expectedSourceHash,
      observations: request.observations,
      embedding: {
        state: 'unavailable',
        ...dependencies.embeddingProvider.descriptor,
        inputHash: calculateCanonicalHash({
          context,
          observations: request.observations,
        }),
      },
      actor: { type: 'api-client', id: actorId },
      createdAt,
    })
    const embedded = await createEmbedding(
      dependencies.embeddingProvider,
      preliminary.searchTextNormalized,
    )
    const domain = catalogSemanticSearchDocument({
      id,
      workspaceId,
      projectId,
      context,
      expectedSourceHash,
      observations: request.observations,
      embedding: embedded.evidence,
      actor: { type: 'api-client', id: actorId },
      createdAt,
    })
    const document: Readonly<PersistedSemanticSearchDocument> =
      Object.freeze({
        ...domain,
        requestFingerprint,
        idempotencyKey: key,
      })
    return dependencies.repository.persistDocument(
      document,
      embedded.vector,
    )
  }
}

function normalizedOptionalText(
  value: unknown,
  field: string,
  maximum = 2_000,
): string | undefined {
  if (value === undefined) return undefined
  assertDomain(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.trim().length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const normalized = normalizeSpeechText(value)
  assertDomain(
    normalized.length > 0,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function normalizedFilters(
  value: HybridSearchFilters | undefined,
): Readonly<HybridSearchFilters> | undefined {
  if (value === undefined) return undefined
  assertDomain(
    typeof value === 'object' && value !== null,
    'INVALID_ARGUMENT',
    'filters is invalid',
  )
  if (value.kinds) {
    assertDomain(
      Array.isArray(value.kinds) &&
        value.kinds.length >= 1 &&
        value.kinds.length <= HYBRID_SEARCH_KINDS.length &&
        value.kinds.every((kind) =>
          HYBRID_SEARCH_KINDS.includes(kind)) &&
        new Set(value.kinds).size === value.kinds.length,
      'INVALID_ARGUMENT',
      'filters.kinds is invalid',
    )
  }
  const people = value.personIds?.map((personId, index) =>
    identity(personId, `filters.personIds[${index}]`))
  assertDomain(
    !people ||
      (people.length >= 1 &&
        people.length <= 20 &&
        new Set(people).size === people.length),
    'INVALID_ARGUMENT',
    'filters.personIds is invalid',
  )
  const minDurationMs = value.minDurationMs
  const maxDurationMs = value.maxDurationMs
  assertDomain(
    (minDurationMs === undefined ||
      (Number.isSafeInteger(minDurationMs) && minDurationMs >= 0)) &&
      (maxDurationMs === undefined ||
        (Number.isSafeInteger(maxDurationMs) &&
          maxDurationMs >= 0)) &&
      (
        minDurationMs === undefined ||
        maxDurationMs === undefined ||
        minDurationMs <= maxDurationMs
      ),
    'INVALID_ARGUMENT',
    'duration filters are invalid',
  )
  assertDomain(
    value.locale === undefined || LOCALE.test(value.locale),
    'INVALID_ARGUMENT',
    'filters.locale is invalid',
  )
  assertDomain(
    value.rights === undefined ||
      ['approved', 'blocked', 'any'].includes(value.rights),
    'INVALID_ARGUMENT',
    'filters.rights is invalid',
  )
  const metadata = value.metadata
  assertDomain(
    metadata === undefined ||
      (
        typeof metadata === 'object' &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        Object.keys(metadata).length >= 1 &&
        Object.keys(metadata).length <= 20 &&
        Object.entries(metadata).every(([key, item]) =>
          TOKEN.test(key) &&
          typeof item === 'string' &&
          normalizeSpeechText(item).length > 0 &&
          item.length <= 500)
      ),
    'INVALID_ARGUMENT',
    'filters.metadata is invalid',
  )
  return Object.freeze({
    ...(value.kinds
      ? { kinds: Object.freeze([...value.kinds]) }
      : {}),
    ...(people ? { personIds: Object.freeze(people) } : {}),
    ...(minDurationMs !== undefined ? { minDurationMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(value.locale ? { locale: value.locale } : {}),
    ...(metadata
      ? {
          metadata: Object.freeze(
            Object.fromEntries(
              Object.entries(metadata)
                .sort(([left], [right]) =>
                  left.localeCompare(right)),
            ),
          ),
        }
      : {}),
    ...(value.rights ? { rights: value.rights } : {}),
  })
}

export function hybridSearchService(dependencies: {
  repository: SemanticSearchRepository
  embeddingProvider: SemanticEmbeddingProvider
  clock: () => Date
}) {
  return async function search(request: {
    workspaceId: string
    projectId: string
    scope?: HybridSearchScope
    text?: string
    intention?: string
    atmosphere?: string
    personIds?: readonly string[]
    speech?: string
    visual?: string
    rightsUse: string
    filters?: HybridSearchFilters
    includeBlocked?: boolean
    limit?: number
    explain?: boolean
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const scope = request.scope ?? 'project'
    assertDomain(
      HYBRID_SEARCH_SCOPES.includes(scope),
      'INVALID_ARGUMENT',
      'scope must be project or workspace',
    )
    const text = normalizedOptionalText(request.text, 'text')
    const intention = normalizedOptionalText(
      request.intention,
      'intention',
    )
    const atmosphere = normalizedOptionalText(
      request.atmosphere,
      'atmosphere',
      500,
    )
    const speech = normalizedOptionalText(request.speech, 'speech')
    const visual = normalizedOptionalText(request.visual, 'visual')
    const personIds = request.personIds?.map((personId, index) =>
      identity(personId, `personIds[${index}]`))
    assertDomain(
      !personIds ||
        (personIds.length >= 1 &&
          personIds.length <= 20 &&
          new Set(personIds).size === personIds.length),
      'INVALID_ARGUMENT',
      'personIds is invalid',
    )
    const filters = normalizedFilters(request.filters)
    assertDomain(
      text !== undefined ||
        intention !== undefined ||
        atmosphere !== undefined ||
        personIds !== undefined ||
        speech !== undefined ||
        visual !== undefined ||
        filters !== undefined,
      'INVALID_ARGUMENT',
      'Hybrid search requires a semantic request or filters',
    )
    assertDomain(
      typeof request.rightsUse === 'string' &&
        TOKEN.test(request.rightsUse),
      'INVALID_ARGUMENT',
      'rightsUse is invalid',
    )
    assertDomain(
      request.includeBlocked === undefined ||
        typeof request.includeBlocked === 'boolean',
      'INVALID_ARGUMENT',
      'includeBlocked must be boolean',
    )
    assertDomain(
      scope !== 'workspace' || request.includeBlocked !== true,
      'INVALID_ARGUMENT',
      'Workspace search cannot include rights-blocked candidates',
    )
    assertDomain(
      scope !== 'workspace' || filters?.rights !== 'blocked',
      'INVALID_ARGUMENT',
      'Workspace search cannot request rights-blocked candidates',
    )
    assertDomain(
      request.explain === undefined ||
        typeof request.explain === 'boolean',
      'INVALID_ARGUMENT',
      'explain must be boolean',
    )
    const query: Readonly<HybridSearchRequest> = Object.freeze({
      scope,
      ...(text ? { text } : {}),
      ...(intention ? { intention } : {}),
      ...(atmosphere ? { atmosphere } : {}),
      ...(personIds
        ? { personIds: Object.freeze(personIds) }
        : {}),
      ...(speech ? { speech } : {}),
      ...(visual ? { visual } : {}),
      rightsUse: request.rightsUse,
      ...(filters ? { filters } : {}),
      includeBlocked: request.includeBlocked ?? false,
      limit: boundedInteger(request.limit ?? 20, 'limit', 1, 100),
      explain: request.explain ?? true,
    })
    const normalizedQueryText = [
      text,
      intention,
      atmosphere,
      speech,
      visual,
    ]
      .filter(Boolean)
      .join('\n')
    const embedded = normalizedQueryText
      ? await createEmbedding(
          dependencies.embeddingProvider,
          normalizedQueryText,
        )
      : null
    const evaluatedAt = canonicalNow(
      dependencies.clock(),
      'hybrid search clock',
    )
    const candidates = await dependencies.repository.searchCandidates({
      workspaceId,
      projectId,
      evaluatedAt,
      query,
      normalizedQueryText,
      ...(embedded?.vector
        ? {
            embedding: {
              descriptor: dependencies.embeddingProvider.descriptor,
              vector: embedded.vector,
            },
          }
        : {}),
      candidateLimit: Math.min(500, Math.max(100, query.limit * 10)),
    })
    return Object.freeze({
      schemaVersion: 'hybrid-search-results/v1' as const,
      query,
      queryHash: calculateCanonicalHash(query),
      semantic: Object.freeze({
        state: embedded?.vector
          ? 'ready' as const
          : 'unavailable' as const,
        ...dependencies.embeddingProvider.descriptor,
      }),
      rerankPolicyVersion: HYBRID_RERANK_POLICY_VERSION,
      results: rerankHybridSearch({
        candidates,
        query,
        now: evaluatedAt,
      }),
      evaluatedAt,
    })
  }
}

export function evaluateHybridRetrievalService(dependencies: {
  repository: SemanticSearchRepository
  search: ReturnType<typeof hybridSearchService>
  clock: () => Date
  createId: () => string
}) {
  return async function evaluate(request: {
    workspaceId: string
    projectId: string
    k: number
    cases: readonly {
      id: string
      query: {
        scope?: HybridSearchScope
        text?: string
        intention?: string
        atmosphere?: string
        personIds?: readonly string[]
        speech?: string
        visual?: string
        rightsUse: string
        filters?: HybridSearchFilters
        includeBlocked?: boolean
      }
      relevantIdentityKeys: readonly string[]
    }[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const k = boundedInteger(request.k, 'k', 1, 100)
    assertDomain(
      Array.isArray(request.cases) &&
        request.cases.length >= 1 &&
        request.cases.length <= 50,
      'INVALID_ARGUMENT',
      'retrieval cases must contain 1 to 50 items',
    )
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'Retrieval evaluation requires an authenticated API client',
    )
    const actorId = identity(request.actor.id, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const normalizedCases = request.cases.map((item, index) => {
      const id = identity(item.id, `cases[${index}].id`)
      assertDomain(
        Array.isArray(item.relevantIdentityKeys) &&
          item.relevantIdentityKeys.length >= 1 &&
          item.relevantIdentityKeys.length <= 500,
        'INVALID_ARGUMENT',
        `cases[${index}].relevantIdentityKeys is invalid`,
      )
      const relevantIdentityKeys = item.relevantIdentityKeys
        .map((value: string, relevantIndex: number) =>
          identity(
            value,
            `cases[${index}].relevantIdentityKeys[${relevantIndex}]`,
          ))
      assertDomain(
        new Set(relevantIdentityKeys).size ===
          relevantIdentityKeys.length,
        'INVALID_ARGUMENT',
        `cases[${index}].relevantIdentityKeys has duplicates`,
      )
      return Object.freeze({
        id,
        query: item.query,
        relevantIdentityKeys: Object.freeze(relevantIdentityKeys),
      })
    })
    assertDomain(
      new Set(normalizedCases.map((item) => item.id)).size ===
        normalizedCases.length,
      'INVALID_ARGUMENT',
      'retrieval case IDs must be unique',
    )
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'evaluate-hybrid-retrieval-request/v1',
      workspaceId,
      projectId,
      k,
      cases: normalizedCases,
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.repository
      .findIdempotentEvaluation({
        workspaceId,
        projectId,
        idempotencyKey: key,
      })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different retrieval evaluation',
        )
      }
      return Object.freeze({ evaluation: replay, replayed: true })
    }
    const evaluatedCases = []
    for (const item of normalizedCases) {
      const result = await dependencies.search({
        workspaceId,
        projectId,
        ...item.query,
        limit: Math.max(k, 20),
        explain: true,
      })
      const rankedIdentityKeys = result.results.map(
        (entry) => entry.document.identityKey,
      )
      evaluatedCases.push(Object.freeze({
        id: item.id,
        queryHash: result.queryHash,
        relevantIdentityKeys: item.relevantIdentityKeys,
        rankedIdentityKeys: Object.freeze(rankedIdentityKeys),
        metrics: calculateRetrievalMetrics({
          rankedIdentityKeys,
          relevantIdentityKeys: item.relevantIdentityKeys,
          k,
        }),
        semanticState: result.semantic.state,
      }))
    }
    const createdAt = canonicalNow(
      dependencies.clock(),
      'retrieval evaluation clock',
    )
    const content = Object.freeze({
      schemaVersion: 'retrieval-evaluation/v1' as const,
      id: identity(
        dependencies.createId(),
        'retrievalEvaluationId',
      ),
      workspaceId,
      projectId,
      policyVersion: RETRIEVAL_EVAL_POLICY_VERSION,
      rerankPolicyVersion: HYBRID_RERANK_POLICY_VERSION,
      k,
      cases: Object.freeze(evaluatedCases),
      aggregate: aggregateRetrievalMetrics(
        evaluatedCases.map((item) => item.metrics),
      ),
      requestFingerprint,
      idempotencyKey: key,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      createdAt,
    })
    const evaluation: Readonly<PersistedRetrievalEvaluation> =
      Object.freeze({
        ...content,
        reportHash: calculateCanonicalHash(content),
      })
    return dependencies.repository.persistEvaluation(evaluation)
  }
}
