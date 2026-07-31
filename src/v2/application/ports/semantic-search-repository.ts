import type {
  CatalogedSemanticSearchDocument,
  HybridSearchCandidate,
  HybridSearchRequest,
  RetrievalMetrics,
  SemanticEmbeddingDescriptor,
  SemanticSearchSourceContext,
} from '../../domain/hybrid-search.ts'

export interface PersistedSemanticSearchDocument
extends CatalogedSemanticSearchDocument {
  requestFingerprint: string
  idempotencyKey: string
}

export interface SemanticSearchSourceRef {
  type:
    | 'artifact'
    | 'speech-segment'
    | 'evidence-segment'
    | 'long-form-moment'
    | 'validated-segment'
  id: string
}

export interface SemanticSearchCandidateQuery {
  workspaceId: string
  projectId: string
  evaluatedAt: string
  query: Readonly<HybridSearchRequest>
  normalizedQueryText: string
  embedding?: Readonly<{
    descriptor: SemanticEmbeddingDescriptor
    vector: readonly number[]
  }>
  candidateLimit: number
}

export interface SemanticSearchCandidateBatch {
  candidates: readonly Readonly<HybridSearchCandidate>[]
  prefilterRejected: readonly Readonly<{
    documentId: string
    identityKey: string
    reasons: readonly string[]
  }>[]
}

export interface PersistedRetrievalEvaluation {
  schemaVersion: 'retrieval-evaluation/v1'
  id: string
  workspaceId: string
  projectId: string
  policyVersion: 'retrieval-eval/v1'
  rerankPolicyVersion: 'hybrid-rerank/v1'
  k: number
  cases: readonly Readonly<{
    id: string
    queryHash: string
    relevantIdentityKeys: readonly string[]
    rankedIdentityKeys: readonly string[]
    metrics: Readonly<RetrievalMetrics>
    semanticState: 'ready' | 'unavailable'
  }>[]
  aggregate: Readonly<RetrievalMetrics>
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  reportHash: string
}

export interface PersistedSemanticReuseRun {
  schemaVersion: 'semantic-reuse-run/v1'
  id: string
  workspaceId: string
  projectId: string
  queryHash: string
  resultSetHash: string
  query: Readonly<HybridSearchRequest>
  semantic: Readonly<{
    state: 'ready' | 'unavailable'
    provider: string
    model: string
    version: string
    dimensions: number
    degraded: boolean
  }>
  rerankPolicyVersion: 'hybrid-rerank/v1'
  candidateAudit: readonly Readonly<{
    documentId: string
    identityKey: string
    rank?: number
    score?: number
    disposition: 'returned' | 'rejected'
    rejectionReasons: readonly string[]
  }>[]
  returnedIdentityKeys: readonly string[]
  reusedIdentityKeys: readonly string[]
  directorRejections: readonly Readonly<{
    identityKey: string
    reason:
      | 'narrative-mismatch'
      | 'duplicate'
      | 'quality-lower'
      | 'duration-mismatch'
      | 'continuity-risk'
      | 'not-needed'
  }>[]
  candidateCount: number
  returnedCount: number
  reusedCount: number
  searchEvaluatedAt: string
  searchLatencyMs: number
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  runHash: string
}

export interface SemanticSearchRepository {
  readSourceContext(input: {
    workspaceId: string
    projectId: string
    source: Readonly<SemanticSearchSourceRef>
  }): Promise<Readonly<SemanticSearchSourceContext> | null>

  findIdempotentDocument(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSemanticSearchDocument> | null>

  persistDocument(
    document: Readonly<PersistedSemanticSearchDocument>,
    vector: readonly number[] | null,
  ): Promise<Readonly<{
    document: Readonly<PersistedSemanticSearchDocument>
    replayed: boolean
  }>>

  searchCandidates(
    query: Readonly<SemanticSearchCandidateQuery>,
  ): Promise<Readonly<SemanticSearchCandidateBatch>>

  findIdempotentEvaluation(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedRetrievalEvaluation> | null>

  persistEvaluation(
    evaluation: Readonly<PersistedRetrievalEvaluation>,
  ): Promise<Readonly<{
    evaluation: Readonly<PersistedRetrievalEvaluation>
    replayed: boolean
  }>>

  findIdempotentReuseRun(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSemanticReuseRun> | null>

  persistReuseRun(
    run: Readonly<PersistedSemanticReuseRun>,
  ): Promise<Readonly<{
    run: Readonly<PersistedSemanticReuseRun>
    replayed: boolean
  }>>
}
