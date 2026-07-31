import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { normalizeSpeechText } from './speech-segment-catalog.ts'

export const SEMANTIC_SEARCH_INDEX_VERSION =
  'semantic-search-index/v1' as const
export const HYBRID_RERANK_POLICY_VERSION =
  'hybrid-rerank/v1' as const
export const RETRIEVAL_EVAL_POLICY_VERSION =
  'retrieval-eval/v1' as const

export const HYBRID_SEARCH_SOURCE_TYPES = [
  'artifact',
  'speech-segment',
  'evidence-segment',
  'long-form-moment',
  'validated-segment',
] as const
export type HybridSearchSourceType =
  (typeof HYBRID_SEARCH_SOURCE_TYPES)[number]

export const HYBRID_SEARCH_KINDS = [
  'image',
  'video',
  'audio',
  'speech-segment',
  'evidence-segment',
  'long-form-moment',
  'validated-segment',
] as const
export type HybridSearchKind =
  (typeof HYBRID_SEARCH_KINDS)[number]

export const HYBRID_SEARCH_SCOPES = [
  'project',
  'workspace',
] as const
export type HybridSearchScope =
  (typeof HYBRID_SEARCH_SCOPES)[number]

export const HYBRID_MATCH_REASONS = [
  'full-text:transcript',
  'full-text:ocr',
  'full-text:description',
  'full-text:intention',
  'vector:intention-description',
  'structured:kind',
  'structured:person',
  'structured:duration',
  'structured:locale',
  'structured:metadata',
  'rights:allowed',
] as const
export type HybridMatchReason =
  (typeof HYBRID_MATCH_REASONS)[number]

export interface SemanticSearchSourceContext {
  source: Readonly<{
    type: HybridSearchSourceType
    id: string
    hash: string
    artifactId: string
    artifactSha256: string
  }>
  kind: HybridSearchKind
  durationMs: number
  locale: string
  personIds: readonly string[]
  transcriptText: string
  intentions: readonly string[]
  description: string
  metadata: Readonly<Record<string, string>>
  rights: Readonly<{
    id: string
    status: string
    consentStatus: string
    allowedUses: readonly string[]
    prohibitedUses: readonly string[]
    expiresAt?: string
    consentExpiresAt?: string
  }>
}

export interface SemanticSearchObservationInput {
  ocrText?: string
  description?: string
  intentions?: readonly string[]
  personIds?: readonly string[]
  metadata?: Readonly<Record<string, string>>
  producer: Readonly<{
    provider: string
    model: string
    version: string
    confidence: number
  }>
}

export interface SemanticEmbeddingDescriptor {
  provider: string
  model: string
  version: string
  dimensions: number
  degraded: boolean
}

export interface SemanticEmbeddingEvidence
extends SemanticEmbeddingDescriptor {
  state: 'ready' | 'unavailable'
  inputHash: string
  vectorHash?: string
}

export interface CatalogedSemanticSearchDocument {
  schemaVersion: 'semantic-search-document/v1'
  id: string
  workspaceId: string
  projectId: string
  source: Readonly<{
    type: HybridSearchSourceType
    id: string
    hash: string
    artifactId: string
    artifactSha256: string
  }>
  identityKey: string
  kind: HybridSearchKind
  durationMs: number
  locale: string
  personIds: readonly string[]
  transcriptText: string
  ocrText: string
  intentions: readonly string[]
  description: string
  metadata: Readonly<Record<string, string>>
  searchTextNormalized: string
  producer: Readonly<{
    provider: string
    model: string
    version: string
    confidence: number
  }>
  embedding: Readonly<SemanticEmbeddingEvidence>
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  indexVersion: typeof SEMANTIC_SEARCH_INDEX_VERSION
  active: boolean
  physicalMaterialized: false
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  documentHash: string
}

export interface HybridSearchFilters {
  kinds?: readonly HybridSearchKind[]
  personIds?: readonly string[]
  minDurationMs?: number
  maxDurationMs?: number
  locale?: string
  metadata?: Readonly<Record<string, string>>
  rights?: 'approved' | 'blocked' | 'any'
}

export interface HybridSearchRequest {
  scope: HybridSearchScope
  text?: string
  intention?: string
  atmosphere?: string
  personIds?: readonly string[]
  speech?: string
  visual?: string
  rightsUse: string
  filters?: Readonly<HybridSearchFilters>
  includeBlocked: boolean
  limit: number
  explain: boolean
}

export interface HybridSearchCandidate {
  document: Readonly<CatalogedSemanticSearchDocument>
  currentRights: SemanticSearchSourceContext['rights'] | null
  fullTextScore: number
  vectorScore: number
}

export interface HybridSearchResult {
  document: Readonly<CatalogedSemanticSearchDocument>
  score: number
  scoreBreakdown: Readonly<{
    fullText: number
    vector: number
    intention: number
    structured: number
    rights: number
  }>
  matchedBy: readonly HybridMatchReason[]
  blockedReasons: readonly string[]
  eligibleForReuse: boolean
  rerankPolicyVersion: typeof HYBRID_RERANK_POLICY_VERSION
}

export interface RetrievalMetrics {
  precisionAtK: number
  recallAtK: number
  ndcgAtK: number
  reciprocalRank: number
  hitsAtK: number
  relevantCount: number
  returnedCount: number
  k: number
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/
const SHA_256 = /^[a-f0-9]{64}$/

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

function text(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): string {
  assertDomain(
    typeof value === 'string' &&
      value.trim().length <= maximum &&
      (allowEmpty || normalizeSpeechText(value.trim()).length > 0),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function token(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim().toLowerCase()
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function confidence(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 1`,
  )
  return value
}

function uniqueIdentities(
  values: readonly string[],
  field: string,
  maximum = 100,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const normalized = values.map((value, index) =>
    identity(value, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicates`,
  )
  return Object.freeze(normalized)
}

function uniqueTokens(
  values: readonly string[],
  field: string,
  maximum = 100,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const normalized = values.map((value, index) =>
    token(value, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicates`,
  )
  return Object.freeze(normalized)
}

function metadata(
  value: Readonly<Record<string, string>>,
  field: string,
): Readonly<Record<string, string>> {
  assertDomain(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 50,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const entries = Object.entries(value)
    .map(([key, item]) => [
      token(key, `${field}.${key}.key`),
      text(item, `${field}.${key}`, 500),
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  assertDomain(
    new Set(entries.map(([key]) => key)).size === entries.length,
    'INVALID_ARGUMENT',
    `${field} has duplicate normalized keys`,
  )
  return Object.freeze(Object.fromEntries(entries))
}

function mergeUnique(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  return Object.freeze([...new Set([...first, ...second])])
}

function mergeMetadata(
  source: Readonly<Record<string, string>>,
  observed: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries({ ...observed, ...source })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  )
}

export function semanticEmbeddingInput(input: {
  transcriptText: string
  ocrText: string
  intentions: readonly string[]
  description: string
  metadata: Readonly<Record<string, string>>
}): string {
  return [
    input.transcriptText,
    input.ocrText,
    input.intentions.join(' '),
    input.description,
    ...Object.entries(input.metadata)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key} ${value}`),
  ]
    .map(normalizeSpeechText)
    .filter(Boolean)
    .join('\n')
}

export function catalogSemanticSearchDocument(input: {
  id: string
  workspaceId: string
  projectId: string
  context: Readonly<SemanticSearchSourceContext>
  expectedSourceHash: string
  observations: SemanticSearchObservationInput
  embedding: SemanticEmbeddingEvidence
  actor: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}): Readonly<CatalogedSemanticSearchDocument> {
  const createdAt = instant(input.createdAt, 'createdAt')
  assertDomain(
    input.actor?.type === 'api-client',
    'AUTH_INVALID',
    'Semantic indexing requires an authenticated API client',
  )
  assertDomain(
    input.expectedSourceHash === input.context.source.hash,
    'VERSION_CONFLICT',
    'Semantic source changed before indexing',
    {
      currentSourceHash: input.context.source.hash,
    },
  )
  assertDomain(
    HYBRID_SEARCH_SOURCE_TYPES.includes(input.context.source.type) &&
      HYBRID_SEARCH_KINDS.includes(input.context.kind),
    'INVALID_ARGUMENT',
    'Semantic source type or kind is invalid',
  )
  assertDomain(
    Number.isSafeInteger(input.context.durationMs) &&
      input.context.durationMs >= 0,
    'INVALID_ARGUMENT',
    'Semantic source duration is invalid',
  )
  assertDomain(
    LOCALE.test(input.context.locale),
    'INVALID_ARGUMENT',
    'Semantic source locale is invalid',
  )
  const sourcePeople = uniqueIdentities(
    input.context.personIds,
    'context.personIds',
  )
  const observedPeople = uniqueIdentities(
    input.observations.personIds ?? [],
    'observations.personIds',
  )
  const sourceIntentions = uniqueTokens(
    input.context.intentions,
    'context.intentions',
  )
  const observedIntentions = uniqueTokens(
    input.observations.intentions ?? [],
    'observations.intentions',
  )
  const sourceMetadata = metadata(
    input.context.metadata,
    'context.metadata',
  )
  const observedMetadata = metadata(
    input.observations.metadata ?? {},
    'observations.metadata',
  )
  const transcriptText = text(
    input.context.transcriptText,
    'context.transcriptText',
    100_000,
    true,
  )
  const ocrText = text(
    input.observations.ocrText ?? '',
    'observations.ocrText',
    100_000,
    true,
  )
  const description = [
    text(
      input.context.description,
      'context.description',
      20_000,
      true,
    ),
    text(
      input.observations.description ?? '',
      'observations.description',
      20_000,
      true,
    ),
  ].filter(Boolean).join('\n')
  const intentions = mergeUnique(
    sourceIntentions,
    observedIntentions,
  )
  const personIds = mergeUnique(sourcePeople, observedPeople)
  const mergedMetadata = mergeMetadata(
    sourceMetadata,
    observedMetadata,
  )
  const searchTextNormalized = semanticEmbeddingInput({
    transcriptText,
    ocrText,
    intentions,
    description,
    metadata: mergedMetadata,
  })
  assertDomain(
    searchTextNormalized.length > 0,
    'INVALID_ARGUMENT',
    'Semantic document requires searchable transcript, OCR, intention, description or metadata',
  )
  const producer = Object.freeze({
    provider: token(
      input.observations.producer.provider,
      'observations.producer.provider',
    ),
    model: token(
      input.observations.producer.model,
      'observations.producer.model',
    ),
    version: token(
      input.observations.producer.version,
      'observations.producer.version',
    ),
    confidence: confidence(
      input.observations.producer.confidence,
      'observations.producer.confidence',
    ),
  })
  assertDomain(
    ['ready', 'unavailable'].includes(input.embedding.state) &&
      Number.isSafeInteger(input.embedding.dimensions) &&
      input.embedding.dimensions >= 8 &&
      input.embedding.dimensions <= 4_096 &&
      typeof input.embedding.degraded === 'boolean',
    'INVALID_ARGUMENT',
    'Embedding evidence is invalid',
  )
  const embedding = Object.freeze({
    state: input.embedding.state,
    provider: token(input.embedding.provider, 'embedding.provider'),
    model: token(input.embedding.model, 'embedding.model'),
    version: token(input.embedding.version, 'embedding.version'),
    dimensions: input.embedding.dimensions,
    degraded: input.embedding.degraded,
    inputHash: hash(input.embedding.inputHash, 'embedding.inputHash'),
    ...(input.embedding.vectorHash
      ? {
          vectorHash: hash(
            input.embedding.vectorHash,
            'embedding.vectorHash',
          ),
        }
      : {}),
  })
  assertDomain(
    (embedding.state === 'ready' && embedding.vectorHash !== undefined) ||
      (embedding.state === 'unavailable' &&
        embedding.vectorHash === undefined),
    'INVALID_ARGUMENT',
    'Embedding state and vector hash disagree',
  )
  const source = Object.freeze({
    type: input.context.source.type,
    id: identity(input.context.source.id, 'context.source.id'),
    hash: hash(input.context.source.hash, 'context.source.hash'),
    artifactId: identity(
      input.context.source.artifactId,
      'context.source.artifactId',
    ),
    artifactSha256: hash(
      input.context.source.artifactSha256,
      'context.source.artifactSha256',
    ),
  })
  const content = Object.freeze({
    schemaVersion: 'semantic-search-document/v1' as const,
    id: identity(input.id, 'semanticDocumentId'),
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    source,
    identityKey: `${source.type}:${source.id}`,
    kind: input.context.kind,
    durationMs: input.context.durationMs,
    locale: input.context.locale,
    personIds,
    transcriptText,
    ocrText,
    intentions,
    description,
    metadata: mergedMetadata,
    searchTextNormalized,
    producer,
    embedding,
    rightsSnapshotId: identity(
      input.context.rights.id,
      'context.rights.id',
    ),
    rightsStatus: text(
      input.context.rights.status,
      'context.rights.status',
      32,
    ),
    consentStatus: text(
      input.context.rights.consentStatus,
      'context.rights.consentStatus',
      32,
    ),
    indexVersion: SEMANTIC_SEARCH_INDEX_VERSION,
    physicalMaterialized: false as const,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: identity(input.actor.id, 'actor.id'),
    }),
    createdAt,
  })
  return Object.freeze({
    ...content,
    active: true,
    documentHash: calculateCanonicalHash(content),
  })
}

function normalizedTerms(...values: (string | undefined)[]): string[] {
  return normalizeSpeechText(values.filter(Boolean).join(' '))
    .split(' ')
    .filter(Boolean)
}

function termCoverage(
  terms: readonly string[],
  values: readonly string[],
): number {
  if (terms.length === 0) return 0
  const corpus = normalizeSpeechText(values.join(' '))
  return terms.filter((term) => corpus.includes(term)).length /
    terms.length
}

function effectiveStatus(
  value: string,
  expiresAt: string | undefined,
  now: string,
): string {
  return expiresAt && Date.parse(expiresAt) <= Date.parse(now)
    ? 'expired'
    : value
}

export function semanticRightsRejectionReasons(input: {
  document: Readonly<CatalogedSemanticSearchDocument>
  current: SemanticSearchSourceContext['rights'] | null
  rightsUse: string
  now: string
}): readonly string[] {
  const rights = input.current
  if (!rights) {
    return Object.freeze(['RIGHTS_MISSING'])
  }
  const status = effectiveStatus(
    rights.status,
    rights.expiresAt,
    input.now,
  )
  const consent = effectiveStatus(
    rights.consentStatus,
    rights.consentExpiresAt,
    input.now,
  )
  return Object.freeze([
    ...(rights.id !== input.document.rightsSnapshotId
      ? ['RIGHTS_SNAPSHOT_STALE']
      : []),
    ...(status !== 'approved'
      ? [`RIGHTS_${status.toUpperCase()}`]
      : []),
    ...(!['approved', 'not-required'].includes(consent)
      ? [`CONSENT_${consent.toUpperCase()}`]
      : []),
    ...(rights.prohibitedUses.includes(input.rightsUse)
      ? ['RIGHTS_USE_PROHIBITED']
      : []),
    ...(!rights.allowedUses.includes(input.rightsUse)
      ? ['RIGHTS_USE_NOT_ALLOWED']
      : []),
  ])
}

function structuredReasons(
  document: Readonly<CatalogedSemanticSearchDocument>,
  query: Readonly<HybridSearchRequest>,
): readonly string[] {
  const filters = query.filters ?? {}
  const normalizedMetadata = metadata(
    filters.metadata ?? {},
    'filters.metadata',
  )
  const visualCorpus = [
    document.ocrText,
    document.description,
    ...Object.values(document.metadata),
  ]
  return Object.freeze([
    ...(filters.kinds &&
    !filters.kinds.includes(document.kind)
      ? ['FILTER_KIND_MISMATCH']
      : []),
    ...(filters.personIds &&
    !filters.personIds.every((personId) =>
      document.personIds.includes(personId))
      ? ['FILTER_PERSON_MISMATCH']
      : []),
    ...(query.personIds &&
    !query.personIds.every((personId) =>
      document.personIds.includes(personId))
      ? ['DIRECTOR_PERSON_MISMATCH']
      : []),
    ...(filters.minDurationMs !== undefined &&
    document.durationMs < filters.minDurationMs
      ? ['FILTER_DURATION_TOO_SHORT']
      : []),
    ...(filters.maxDurationMs !== undefined &&
    document.durationMs > filters.maxDurationMs
      ? ['FILTER_DURATION_TOO_LONG']
      : []),
    ...(filters.locale && document.locale !== filters.locale
      ? ['FILTER_LOCALE_MISMATCH']
      : []),
    ...(!Object.entries(normalizedMetadata).every(
      ([key, value]) =>
        normalizeSpeechText(document.metadata[key] ?? '') ===
        normalizeSpeechText(value),
    )
      ? ['FILTER_METADATA_MISMATCH']
      : []),
    ...(query.atmosphere &&
    normalizeSpeechText(document.metadata.atmosphere ?? '') !==
      normalizeSpeechText(query.atmosphere)
      ? ['DIRECTOR_ATMOSPHERE_MISMATCH']
      : []),
    ...(query.speech &&
    termCoverage(normalizedTerms(query.speech), [
      document.transcriptText,
    ]) < 0.5
      ? ['DIRECTOR_SPEECH_MISMATCH']
      : []),
    ...(query.visual &&
    termCoverage(normalizedTerms(query.visual), visualCorpus) < 0.5
      ? ['DIRECTOR_VISUAL_MISMATCH']
      : []),
  ])
}

function matchedFields(
  candidate: Readonly<HybridSearchCandidate>,
  query: Readonly<HybridSearchRequest>,
): readonly HybridMatchReason[] {
  const generalTerms = normalizedTerms(query.text, query.intention)
  const speechTerms = normalizedTerms(query.speech)
  const visualTerms = normalizedTerms(query.visual)
  const document = candidate.document
  const filters = query.filters ?? {}
  return Object.freeze([
    ...(termCoverage(
      [...generalTerms, ...speechTerms],
      [document.transcriptText],
    ) > 0
      ? ['full-text:transcript' as const]
      : []),
    ...(termCoverage(
      [...generalTerms, ...visualTerms],
      [document.ocrText],
    ) > 0
      ? ['full-text:ocr' as const]
      : []),
    ...(termCoverage(
      [...generalTerms, ...visualTerms],
      [document.description],
    ) > 0
      ? ['full-text:description' as const]
      : []),
    ...(termCoverage(generalTerms, document.intentions) > 0
      ? ['full-text:intention' as const]
      : []),
    ...(candidate.vectorScore > 0
      ? ['vector:intention-description' as const]
      : []),
    ...(filters.kinds?.includes(document.kind)
      ? ['structured:kind' as const]
      : []),
    ...((query.personIds ?? filters.personIds)?.every((personId) =>
      document.personIds.includes(personId))
      ? ['structured:person' as const]
      : []),
    ...(filters.minDurationMs !== undefined ||
    filters.maxDurationMs !== undefined
      ? ['structured:duration' as const]
      : []),
    ...(filters.locale === document.locale
      ? ['structured:locale' as const]
      : []),
    ...((query.atmosphere ||
    (filters.metadata && Object.keys(filters.metadata).length > 0))
      ? ['structured:metadata' as const]
      : []),
  ])
}

function finiteScore(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 1`,
  )
  return value
}

export function rerankHybridSearch(input: {
  candidates: readonly Readonly<HybridSearchCandidate>[]
  query: Readonly<HybridSearchRequest>
  now: string
}): readonly Readonly<HybridSearchResult>[] {
  const now = instant(input.now, 'now')
  const filters = input.query.filters ?? {}
  assertDomain(
    typeof input.query.rightsUse === 'string' &&
      TOKEN.test(input.query.rightsUse) &&
      Number.isSafeInteger(input.query.limit) &&
      input.query.limit >= 1 &&
      input.query.limit <= 100,
    'INVALID_ARGUMENT',
    'Hybrid search request is invalid',
  )
  const intentionTerms = normalizedTerms(input.query.intention)
  const ranked = input.candidates.map((candidate) => {
    const fullText = finiteScore(
      candidate.fullTextScore,
      'candidate.fullTextScore',
    )
    const vector = finiteScore(
      candidate.vectorScore,
      'candidate.vectorScore',
    )
    const intention = termCoverage(intentionTerms, [
      ...candidate.document.intentions,
      candidate.document.description,
    ])
    const structuredBlocked = structuredReasons(
      candidate.document,
      input.query,
    )
    const rightsBlocked = semanticRightsRejectionReasons({
      document: candidate.document,
      current: candidate.currentRights,
      rightsUse: input.query.rightsUse,
      now,
    })
    const rightsFilterBlocked =
      filters.rights === 'approved' && rightsBlocked.length > 0
        ? ['FILTER_RIGHTS_APPROVED_REQUIRED']
        : filters.rights === 'blocked' && rightsBlocked.length === 0
          ? ['FILTER_RIGHTS_BLOCKED_REQUIRED']
          : []
    const blockedReasons = Object.freeze([
      ...rightsBlocked,
      ...structuredBlocked,
      ...rightsFilterBlocked,
    ])
    const structured = structuredBlocked.length === 0 ? 1 : 0
    const rights = rightsBlocked.length === 0 ? 1 : 0
    const hasText = Boolean(
      normalizeSpeechText(
        `${input.query.text ?? ''} ${input.query.intention ?? ''} ` +
        `${input.query.speech ?? ''} ${input.query.visual ?? ''}`,
      ),
    )
    const vectorAvailable =
      hasText && candidate.document.embedding.state === 'ready'
    const weights = {
      fullText: hasText ? 0.25 : 0,
      vector: vectorAvailable ? 0.35 : 0,
      intention: intentionTerms.length > 0 ? 0.15 : 0,
      structured: 0.10,
      rights: 0.15,
    }
    const totalWeight = Object.values(weights)
      .reduce((sum, value) => sum + value, 0)
    const score =
      (
        fullText * weights.fullText +
        vector * weights.vector +
        intention * weights.intention +
        structured * weights.structured +
        rights * weights.rights
      ) / totalWeight
    const matchedBy = [
      ...matchedFields(candidate, input.query),
      ...(rights === 1 ? ['rights:allowed' as const] : []),
    ]
    return Object.freeze({
      document: candidate.document,
      score: Number(score.toFixed(6)),
      scoreBreakdown: Object.freeze({
        fullText,
        vector,
        intention: Number(intention.toFixed(6)),
        structured,
        rights,
      }),
      matchedBy: input.query.explain
        ? Object.freeze(matchedBy)
        : Object.freeze([]),
      blockedReasons: input.query.explain
        ? blockedReasons
        : Object.freeze([]),
      eligibleForReuse: blockedReasons.length === 0,
      rerankPolicyVersion: HYBRID_RERANK_POLICY_VERSION,
    })
  })
  const requiresRetrievalSignal = Boolean(
    normalizeSpeechText(
      `${input.query.text ?? ''} ${input.query.intention ?? ''} ` +
      `${input.query.speech ?? ''} ${input.query.visual ?? ''}`,
    ),
  )
  const retrievalTerms = normalizedTerms(
    input.query.text,
    input.query.intention,
    input.query.speech,
    input.query.visual,
  )
  const relevant = ranked.filter((result) =>
    !requiresRetrievalSignal ||
    termCoverage(retrievalTerms, [
      result.document.transcriptText,
      result.document.ocrText,
      result.document.description,
      ...result.document.intentions,
    ]) > 0 ||
    result.scoreBreakdown.fullText >= 0.2 ||
    result.scoreBreakdown.intention > 0 ||
    result.scoreBreakdown.vector >= 0.35)
  const deduped = new Map<string, Readonly<HybridSearchResult>>()
  for (const result of relevant) {
    const existing = deduped.get(result.document.identityKey)
    if (
      !existing ||
      Number(result.eligibleForReuse) >
        Number(existing.eligibleForReuse) ||
      (
        result.eligibleForReuse === existing.eligibleForReuse &&
        (
          result.score > existing.score ||
          (
            result.score === existing.score &&
            Date.parse(result.document.createdAt) >
              Date.parse(existing.document.createdAt)
          )
        )
      )
    ) {
      deduped.set(result.document.identityKey, result)
    }
  }
  return Object.freeze(
    [...deduped.values()]
      .filter((result) =>
        input.query.includeBlocked || result.eligibleForReuse)
      .sort((left, right) =>
        Number(right.eligibleForReuse) -
          Number(left.eligibleForReuse) ||
        right.score - left.score ||
        left.document.identityKey.localeCompare(
          right.document.identityKey,
        ))
      .slice(0, input.query.limit),
  )
}

export function calculateRetrievalMetrics(input: {
  rankedIdentityKeys: readonly string[]
  relevantIdentityKeys: readonly string[]
  k: number
}): Readonly<RetrievalMetrics> {
  assertDomain(
    Number.isSafeInteger(input.k) && input.k >= 1 && input.k <= 100,
    'INVALID_ARGUMENT',
    'retrieval k is invalid',
  )
  const ranked = uniqueIdentities(
    input.rankedIdentityKeys,
    'rankedIdentityKeys',
    10_000,
  )
  const relevant = uniqueIdentities(
    input.relevantIdentityKeys,
    'relevantIdentityKeys',
    10_000,
  )
  assertDomain(
    relevant.length > 0,
    'INVALID_ARGUMENT',
    'relevantIdentityKeys must not be empty',
  )
  const relevantSet = new Set(relevant)
  const top = ranked.slice(0, input.k)
  const hits = top.filter((id) => relevantSet.has(id))
  const dcg = top.reduce(
    (sum, id, index) =>
      sum + (relevantSet.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  )
  const idealCount = Math.min(input.k, relevant.length)
  const ideal = Array.from(
    { length: idealCount },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((sum, value) => sum + value, 0)
  const firstRelevant = ranked.findIndex((id) => relevantSet.has(id))
  return Object.freeze({
    precisionAtK: hits.length / input.k,
    recallAtK: hits.length / relevant.length,
    ndcgAtK: ideal > 0 ? dcg / ideal : 0,
    reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
    hitsAtK: hits.length,
    relevantCount: relevant.length,
    returnedCount: ranked.length,
    k: input.k,
  })
}

export function aggregateRetrievalMetrics(
  cases: readonly Readonly<RetrievalMetrics>[],
): Readonly<RetrievalMetrics> {
  assertDomain(
    cases.length > 0,
    'INVALID_ARGUMENT',
    'retrieval evaluation requires at least one case',
  )
  const average = (
    select: (metrics: Readonly<RetrievalMetrics>) => number,
  ) => cases.reduce(
    (sum, metrics) => sum + select(metrics),
    0,
  ) / cases.length
  return Object.freeze({
    precisionAtK: average((metrics) => metrics.precisionAtK),
    recallAtK: average((metrics) => metrics.recallAtK),
    ndcgAtK: average((metrics) => metrics.ndcgAtK),
    reciprocalRank: average((metrics) => metrics.reciprocalRank),
    hitsAtK: cases.reduce(
      (sum, metrics) => sum + metrics.hitsAtK,
      0,
    ),
    relevantCount: cases.reduce(
      (sum, metrics) => sum + metrics.relevantCount,
      0,
    ),
    returnedCount: cases.reduce(
      (sum, metrics) => sum + metrics.returnedCount,
      0,
    ),
    k: cases[0]!.k,
  })
}
