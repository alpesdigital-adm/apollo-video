import {
  Prisma,
  type PrismaClient,
  type V2AssetRightsSnapshot,
  type V2RetrievalEvaluation,
  type V2SemanticSearchDocument,
  type V2SemanticReuseRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedRetrievalEvaluation,
  PersistedSemanticSearchDocument,
  PersistedSemanticReuseRun,
  SemanticSearchCandidateQuery,
  SemanticSearchRepository,
  SemanticSearchSourceRef,
} from '../../application/ports/semantic-search-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  HYBRID_RERANK_POLICY_VERSION,
  RETRIEVAL_EVAL_POLICY_VERSION,
  SEMANTIC_SEARCH_INDEX_VERSION,
  semanticEmbeddingInput,
  semanticRightsRejectionReasons,
  type CatalogedSemanticSearchDocument,
  type RetrievalMetrics,
  type SemanticSearchSourceContext,
} from '../../domain/hybrid-search.ts'
import { normalizeSpeechText } from '../../domain/speech-segment-catalog.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type SearchRow = V2SemanticSearchDocument & {
  sourceArtifact: {
    currentRightsSnapshot: V2AssetRightsSnapshot | null
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function parseJson(value: string, field: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown
    if (stableSerialize(parsed) !== value) {
      throw new Error('non-canonical')
    }
    return parsed
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid or non-canonical`,
    )
  }
}

function record(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return value as Record<string, unknown>
}

function stringArray(value: string, field: string): readonly string[] {
  const parsed = parseJson(value, field)
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'string')
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return Object.freeze([...parsed])
}

function numberArray(value: string, field: string): readonly number[] {
  const parsed = parseJson(value, field)
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) =>
      typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return Object.freeze([...parsed])
}

function stringRecord(
  value: string,
  field: string,
): Readonly<Record<string, string>> {
  const parsed = record(parseJson(value, field), field)
  if (
    !Object.values(parsed).every((item) => typeof item === 'string')
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return Object.freeze({ ...parsed } as Record<string, string>)
}

function normalizedItems(values: readonly string[]): string {
  return `\n${values.map(normalizeSpeechText).join('\n')}\n`
}

function metadataSearch(
  value: Readonly<Record<string, string>>,
): string {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => normalizeSpeechText(`${key} ${item}`))
    .join('\n')
}

function jsonValue(value: string, field: string): unknown {
  return parseJson(value, field)
}

function observedValue(value: string | null): string {
  if (!value) return ''
  const parsed = jsonValue(value, 'observed value')
  if (typeof parsed === 'string') return parsed
  const candidate = record(parsed, 'observed value')
  return typeof candidate.value === 'string' ? candidate.value : ''
}

function observedValues(value: string): readonly string[] {
  const parsed = jsonValue(value, 'observed values')
  if (!Array.isArray(parsed)) return Object.freeze([])
  return Object.freeze(parsed.flatMap((item) => {
    if (typeof item === 'string') return [item]
    if (
      typeof item === 'object' &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).value === 'string'
    ) {
      return [(item as Record<string, string>).value]
    }
    return []
  }))
}

function canonicalToken(value: string): string {
  return normalizeSpeechText(value)
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]/g, '')
    .slice(0, 128)
}

function canonicalTokens(values: readonly string[]): readonly string[] {
  return Object.freeze([
    ...new Set(values.map(canonicalToken).filter(Boolean)),
  ])
}

function currentRights(
  row: V2AssetRightsSnapshot,
): Readonly<SemanticSearchSourceContext['rights']> {
  return Object.freeze({
    id: row.id,
    status: row.status,
    consentStatus: row.consentStatus,
    allowedUses: stringArray(
      row.allowedUsesJson,
      'rights allowed uses',
    ),
    prohibitedUses: stringArray(
      row.prohibitedUsesJson,
      'rights prohibited uses',
    ),
    ...(row.expiresAt
      ? { expiresAt: row.expiresAt.toISOString() }
      : {}),
    ...(row.consentExpiresAt
      ? { consentExpiresAt: row.consentExpiresAt.toISOString() }
      : {}),
  })
}

function embeddingJson(
  vector: readonly number[] | null,
): string {
  return stableSerialize(vector ? [...vector] : [])
}

function vectorLiteral(vector: readonly number[]): string {
  if (
    vector.length !== 256 ||
    !vector.every((value) =>
      Number.isFinite(value) && value >= -1 && value <= 1)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Semantic embedding vector is invalid',
    )
  }
  return `[${vector.map((value) => Number(value).toString()).join(',')}]`
}

function hydrateDocument(
  row: V2SemanticSearchDocument,
): Readonly<PersistedSemanticSearchDocument> {
  const personIds = stringArray(row.personIdsJson, 'person IDs')
  const intentions = stringArray(row.intentionsJson, 'intentions')
  const metadata = stringRecord(row.metadataJson, 'metadata')
  const producer = Object.freeze(
    record(
      parseJson(row.producerJson, 'producer'),
      'producer',
    ) as unknown as {
      provider: string
      model: string
      version: string
      confidence: number
    },
  )
  const vector = numberArray(row.embeddingJson, 'embedding vector')
  const embedding = Object.freeze({
    state: row.embeddingState as 'ready' | 'unavailable',
    provider: row.embeddingProvider,
    model: row.embeddingModel,
    version: row.embeddingVersion,
    dimensions: row.embeddingDimensions,
    degraded: row.embeddingDegraded,
    inputHash: row.embeddingInputHash,
    ...(row.embeddingVectorHash
      ? { vectorHash: row.embeddingVectorHash }
      : {}),
  })
  const source = Object.freeze({
    type:
      row.sourceType as CatalogedSemanticSearchDocument['source']['type'],
    id: row.sourceId,
    hash: row.sourceHash,
    artifactId: row.sourceArtifactId,
    artifactSha256: row.sourceArtifactSha256,
  })
  const content = Object.freeze({
    schemaVersion: 'semantic-search-document/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    source,
    identityKey: row.identityKey,
    kind: row.kind as CatalogedSemanticSearchDocument['kind'],
    durationMs: row.durationMs,
    locale: row.locale,
    personIds,
    transcriptText: row.transcriptText,
    ocrText: row.ocrText,
    intentions,
    description: row.description,
    metadata,
    searchTextNormalized: row.searchTextNormalized,
    producer,
    embedding,
    rightsSnapshotId: row.rightsSnapshotId,
    rightsStatus: row.rightsStatus,
    consentStatus: row.consentStatus,
    indexVersion: SEMANTIC_SEARCH_INDEX_VERSION,
    physicalMaterialized: false as const,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.identityKey !== `${row.sourceType}:${row.sourceId}` ||
    stableSerialize(personIds) !== row.personIdsJson ||
    normalizedItems(personIds) !== row.personIdsNormalized ||
    stableSerialize(intentions) !== row.intentionsJson ||
    normalizedItems(intentions) !== row.intentionsNormalized ||
    stableSerialize(metadata) !== row.metadataJson ||
    metadataSearch(metadata) !== row.metadataSearchNormalized ||
    semanticEmbeddingInput({
      transcriptText: row.transcriptText,
      ocrText: row.ocrText,
      intentions,
      description: row.description,
      metadata,
    }) !== row.searchTextNormalized ||
    stableSerialize(producer) !== row.producerJson ||
    row.indexVersion !== SEMANTIC_SEARCH_INDEX_VERSION ||
    row.physicalMaterialized ||
    row.createdByType !== 'api-client' ||
    row.embeddingDimensions !== 256 ||
    (
      row.embeddingState === 'ready' &&
      (
        vector.length !== 256 ||
        !row.embeddingVectorHash ||
        calculateCanonicalHash(vector) !== row.embeddingVectorHash
      )
    ) ||
    (
      row.embeddingState === 'unavailable' &&
      (vector.length !== 0 || row.embeddingVectorHash !== null)
    ) ||
    calculateCanonicalHash(content) !== row.documentHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored semantic document ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    ...content,
    active: row.active,
    documentHash: row.documentHash,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

function documentData(
  document: Readonly<PersistedSemanticSearchDocument>,
  vector: readonly number[] | null,
) {
  return {
    id: document.id,
    workspaceId: document.workspaceId,
    projectId: document.projectId,
    sourceType: document.source.type,
    sourceId: document.source.id,
    sourceHash: document.source.hash,
    identityKey: document.identityKey,
    sourceArtifactId: document.source.artifactId,
    sourceArtifactSha256: document.source.artifactSha256,
    kind: document.kind,
    durationMs: document.durationMs,
    locale: document.locale,
    personIdsJson: stableSerialize(document.personIds),
    personIdsNormalized: normalizedItems(document.personIds),
    transcriptText: document.transcriptText,
    ocrText: document.ocrText,
    intentionsJson: stableSerialize(document.intentions),
    intentionsNormalized: normalizedItems(document.intentions),
    description: document.description,
    metadataJson: stableSerialize(document.metadata),
    metadataSearchNormalized: metadataSearch(document.metadata),
    searchTextNormalized: document.searchTextNormalized,
    producerJson: stableSerialize(document.producer),
    embeddingState: document.embedding.state,
    embeddingProvider: document.embedding.provider,
    embeddingModel: document.embedding.model,
    embeddingVersion: document.embedding.version,
    embeddingDimensions: document.embedding.dimensions,
    embeddingDegraded: document.embedding.degraded,
    embeddingInputHash: document.embedding.inputHash,
    embeddingVectorHash: document.embedding.vectorHash,
    embeddingJson: embeddingJson(vector),
    rightsSnapshotId: document.rightsSnapshotId,
    rightsStatus: document.rightsStatus,
    consentStatus: document.consentStatus,
    indexVersion: document.indexVersion,
    active: document.active,
    physicalMaterialized: document.physicalMaterialized,
    requestFingerprint: document.requestFingerprint,
    idempotencyKey: document.idempotencyKey,
    createdByType: document.createdBy.type,
    createdById: document.createdBy.id,
    createdAt: new Date(document.createdAt),
    documentHash: document.documentHash,
  }
}

function hydrateEvaluation(
  row: V2RetrievalEvaluation,
): Readonly<PersistedRetrievalEvaluation> {
  const cases = parseJson(
    row.casesJson,
    'retrieval evaluation cases',
  ) as PersistedRetrievalEvaluation['cases']
  const aggregate = parseJson(
    row.aggregateJson,
    'retrieval evaluation aggregate',
  ) as Readonly<RetrievalMetrics>
  if (!Array.isArray(cases)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored retrieval evaluation ${row.id} has invalid cases`,
    )
  }
  const content = Object.freeze({
    schemaVersion: 'retrieval-evaluation/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    policyVersion: RETRIEVAL_EVAL_POLICY_VERSION,
    rerankPolicyVersion: HYBRID_RERANK_POLICY_VERSION,
    k: row.k,
    cases: Object.freeze([...cases]),
    aggregate: Object.freeze({ ...aggregate }),
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.policyVersion !== RETRIEVAL_EVAL_POLICY_VERSION ||
    row.rerankPolicyVersion !== HYBRID_RERANK_POLICY_VERSION ||
    row.caseCount !== cases.length ||
    stableSerialize(cases) !== row.casesJson ||
    stableSerialize(aggregate) !== row.aggregateJson ||
    row.createdByType !== 'api-client' ||
    calculateCanonicalHash(content) !== row.reportHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored retrieval evaluation ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    ...content,
    reportHash: row.reportHash,
  })
}

function evaluationData(
  evaluation: Readonly<PersistedRetrievalEvaluation>,
) {
  return {
    id: evaluation.id,
    workspaceId: evaluation.workspaceId,
    projectId: evaluation.projectId,
    policyVersion: evaluation.policyVersion,
    rerankPolicyVersion: evaluation.rerankPolicyVersion,
    k: evaluation.k,
    caseCount: evaluation.cases.length,
    casesJson: stableSerialize(evaluation.cases),
    aggregateJson: stableSerialize(evaluation.aggregate),
    requestFingerprint: evaluation.requestFingerprint,
    idempotencyKey: evaluation.idempotencyKey,
    createdByType: evaluation.createdBy.type,
    createdById: evaluation.createdBy.id,
    createdAt: new Date(evaluation.createdAt),
    reportHash: evaluation.reportHash,
  }
}

function hydrateReuseRun(
  row: V2SemanticReuseRun,
): Readonly<PersistedSemanticReuseRun> {
  const query = parseJson(
    row.queryJson,
    'semantic reuse query',
  ) as PersistedSemanticReuseRun['query']
  const semantic = parseJson(
    row.semanticJson,
    'semantic reuse embedding state',
  ) as PersistedSemanticReuseRun['semantic']
  const candidateAudit = parseJson(
    row.candidateAuditJson,
    'semantic reuse candidate audit',
  ) as PersistedSemanticReuseRun['candidateAudit']
  const returnedIdentityKeys = stringArray(
    row.returnedIdentityKeysJson,
    'semantic reuse returned identities',
  )
  const reusedIdentityKeys = stringArray(
    row.reusedIdentityKeysJson,
    'semantic reuse identities',
  )
  const directorRejections = parseJson(
    row.directorRejectionsJson,
    'semantic reuse director rejections',
  ) as PersistedSemanticReuseRun['directorRejections']
  if (
    !Array.isArray(candidateAudit) ||
    !Array.isArray(directorRejections)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored semantic reuse run ${row.id} has invalid audit data`,
    )
  }
  const content = Object.freeze({
    schemaVersion: 'semantic-reuse-run/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    queryHash: row.queryHash,
    resultSetHash: row.resultSetHash,
    query: Object.freeze({ ...query }),
    semantic: Object.freeze({ ...semantic }),
    rerankPolicyVersion: HYBRID_RERANK_POLICY_VERSION,
    candidateAudit: Object.freeze([...candidateAudit]),
    returnedIdentityKeys,
    reusedIdentityKeys,
    directorRejections: Object.freeze([...directorRejections]),
    candidateCount: row.candidateCount,
    returnedCount: row.returnedCount,
    reusedCount: row.reusedCount,
    searchEvaluatedAt: row.searchEvaluatedAt.toISOString(),
    searchLatencyMs: row.searchLatencyMs,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdByClientId,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (
    stableSerialize(query) !== row.queryJson ||
    stableSerialize(semantic) !== row.semanticJson ||
    stableSerialize(candidateAudit) !== row.candidateAuditJson ||
    stableSerialize(returnedIdentityKeys) !==
      row.returnedIdentityKeysJson ||
    stableSerialize(reusedIdentityKeys) !==
      row.reusedIdentityKeysJson ||
    stableSerialize(directorRejections) !==
      row.directorRejectionsJson ||
    row.rerankPolicyVersion !== HYBRID_RERANK_POLICY_VERSION ||
    row.candidateCount !== candidateAudit.length ||
    row.returnedCount !== returnedIdentityKeys.length ||
    row.reusedCount !== reusedIdentityKeys.length ||
    calculateCanonicalHash(query) !== row.queryHash ||
    calculateCanonicalHash(content) !== row.runHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored semantic reuse run ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({ ...content, runHash: row.runHash })
}

function reuseRunData(
  run: Readonly<PersistedSemanticReuseRun>,
) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    queryHash: run.queryHash,
    resultSetHash: run.resultSetHash,
    queryJson: stableSerialize(run.query),
    semanticJson: stableSerialize(run.semantic),
    rerankPolicyVersion: run.rerankPolicyVersion,
    candidateAuditJson: stableSerialize(run.candidateAudit),
    returnedIdentityKeysJson:
      stableSerialize(run.returnedIdentityKeys),
    reusedIdentityKeysJson: stableSerialize(run.reusedIdentityKeys),
    directorRejectionsJson:
      stableSerialize(run.directorRejections),
    candidateCount: run.candidateCount,
    returnedCount: run.returnedCount,
    reusedCount: run.reusedCount,
    searchEvaluatedAt: new Date(run.searchEvaluatedAt),
    searchLatencyMs: run.searchLatencyMs,
    requestFingerprint: run.requestFingerprint,
    idempotencyKey: run.idempotencyKey,
    createdByClientId: run.createdBy.id,
    createdAt: new Date(run.createdAt),
    runHash: run.runHash,
  }
}

type DbClient = PrismaClient | Prisma.TransactionClient

async function sourceHashExists(
  client: DbClient,
  document: Readonly<PersistedSemanticSearchDocument>,
): Promise<boolean> {
  const base = {
    id: document.source.id,
    workspaceId: document.workspaceId,
  }
  if (document.source.type === 'artifact') {
    return Boolean(await client.v2MediaArtifact.findFirst({
      where: {
        ...base,
        sha256: document.source.hash,
        status: 'available',
      },
      select: { id: true },
    }))
  }
  if (document.source.type === 'speech-segment') {
    return Boolean(await client.v2SpeechSegment.findFirst({
      where: {
        ...base,
        projectId: document.projectId,
        segmentHash: document.source.hash,
        physicalMaterialized: false,
        catalogRun: { active: true },
      },
      select: { id: true },
    }))
  }
  if (document.source.type === 'evidence-segment') {
    return Boolean(await client.v2EvidenceSegment.findFirst({
      where: {
        ...base,
        projectId: document.projectId,
        evidenceHash: document.source.hash,
        physicalMaterialized: false,
      },
      select: { id: true },
    }))
  }
  if (document.source.type === 'long-form-moment') {
    return Boolean(await client.v2LongFormMoment.findFirst({
      where: {
        ...base,
        projectId: document.projectId,
        momentHash: document.source.hash,
        physicalMaterialized: false,
        indexRun: { active: true },
      },
      select: { id: true },
    }))
  }
  return Boolean(await client.v2ValidatedSegment.findFirst({
    where: {
      ...base,
      projectId: document.projectId,
      validatedSegmentHash: document.source.hash,
      physicalMaterialized: false,
      causalClaimAllowed: false,
    },
    select: { id: true },
  }))
}

function manifestDuration(manifestJson: string): number {
  try {
    const value = JSON.parse(manifestJson) as {
      probe?: { duration?: unknown }
    }
    const duration = value.probe?.duration
    return typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration > 0
      ? Math.round(duration * 1_000)
      : 0
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored artifact manifest is invalid JSON',
    )
  }
}

function projectLocale(locale: string | null): string {
  return locale && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)
    ? locale
    : 'und'
}

export class PrismaSemanticSearchRepository
implements SemanticSearchRepository {
  private readonly client: PrismaClient

  constructor(
    client: PrismaClient = getV2PostgresClient(),
  ) {
    this.client = client
  }

  async readSourceContext(input: {
    workspaceId: string
    projectId: string
    source: Readonly<SemanticSearchSourceRef>
  }): Promise<Readonly<SemanticSearchSourceContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: {
        id: input.projectId,
        workspaceId: input.workspaceId,
      },
      select: { id: true, locale: true },
    })
    if (!project) return null
    const locale = projectLocale(project.locale)
    if (input.source.type === 'artifact') {
      const artifact = await this.client.v2MediaArtifact.findFirst({
        where: {
          id: input.source.id,
          workspaceId: input.workspaceId,
          status: 'available',
          mediaType: { in: ['image', 'video', 'audio'] },
          projectAssets: {
            some: {
              projectId: input.projectId,
              workspaceId: input.workspaceId,
            },
          },
        },
        include: {
          currentRightsSnapshot: true,
          manifests: {
            orderBy: { createdAt: 'desc' },
            take: 20,
          },
        },
      })
      if (!artifact?.currentRightsSnapshot) return null
      const durationMs = artifact.mediaType === 'image'
        ? 0
        : artifact.manifests
          .map((manifest) => manifestDuration(manifest.manifestJson))
          .find((duration) => duration > 0) ?? 0
      return Object.freeze({
        source: Object.freeze({
          type: 'artifact' as const,
          id: artifact.id,
          hash: artifact.sha256,
          artifactId: artifact.id,
          artifactSha256: artifact.sha256,
        }),
        kind: artifact.mediaType as 'image' | 'video' | 'audio',
        durationMs,
        locale,
        personIds: Object.freeze([]),
        transcriptText: '',
        intentions: Object.freeze([]),
        description: '',
        metadata: Object.freeze({
          'container': artifact.container,
          'duration-known': durationMs > 0 || artifact.mediaType === 'image'
            ? 'true'
            : 'false',
        }),
        rights: currentRights(artifact.currentRightsSnapshot),
      })
    }
    if (input.source.type === 'speech-segment') {
      const segment = await this.client.v2SpeechSegment.findFirst({
        where: {
          id: input.source.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          physicalMaterialized: false,
          catalogRun: { active: true },
        },
        include: {
          sourceArtifact: { include: { currentRightsSnapshot: true } },
        },
      })
      if (!segment?.sourceArtifact.currentRightsSnapshot) return null
      const intentions = canonicalTokens(
        observedValues(segment.intentionsJson),
      )
      const description = [
        segment.emotionNormalized,
        segment.expressionNormalized,
        segment.wardrobeNormalized,
        segment.settingNormalized,
      ].filter((value): value is string => Boolean(value)).join(' ')
      return Object.freeze({
        source: Object.freeze({
          type: 'speech-segment' as const,
          id: segment.id,
          hash: segment.segmentHash,
          artifactId: segment.sourceArtifactId,
          artifactSha256: segment.sourceArtifact.sha256,
        }),
        kind: 'speech-segment' as const,
        durationMs: segment.endMs - segment.startMs,
        locale,
        personIds: Object.freeze([segment.speakerId]),
        transcriptText: segment.exactText,
        intentions,
        description,
        metadata: Object.freeze({
          classification: segment.classification,
          'complete-thought-score':
            segment.completeThoughtScore.toString(),
        }),
        rights: currentRights(
          segment.sourceArtifact.currentRightsSnapshot,
        ),
      })
    }
    if (input.source.type === 'evidence-segment') {
      const evidence = await this.client.v2EvidenceSegment.findFirst({
        where: {
          id: input.source.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          physicalMaterialized: false,
        },
        include: {
          sourceArtifact: { include: { currentRightsSnapshot: true } },
        },
      })
      if (!evidence?.sourceArtifact.currentRightsSnapshot) return null
      return Object.freeze({
        source: Object.freeze({
          type: 'evidence-segment' as const,
          id: evidence.id,
          hash: evidence.evidenceHash,
          artifactId: evidence.sourceArtifactId,
          artifactSha256: evidence.sourceArtifact.sha256,
        }),
        kind: 'evidence-segment' as const,
        durationMs: evidence.sourceEndMs - evidence.sourceStartMs,
        locale,
        personIds: Object.freeze([evidence.speakerId]),
        transcriptText: evidence.exactTranscript,
        intentions: Object.freeze([
          'proof',
          canonicalToken(evidence.category),
        ].filter(Boolean)),
        description: [
          observedValue(evidence.claimJson),
          observedValue(evidence.resultJson),
          observedValue(evidence.contextJson),
          observedValue(evidence.subjectJson),
          observedValue(evidence.attributionJson),
        ].filter(Boolean).join('\n'),
        metadata: Object.freeze({
          category: evidence.category,
          integrity: evidence.integrityStatus,
          'requires-context': evidence.requiresContext
            ? 'true'
            : 'false',
        }),
        rights: currentRights(
          evidence.sourceArtifact.currentRightsSnapshot,
        ),
      })
    }
    if (input.source.type === 'long-form-moment') {
      const moment = await this.client.v2LongFormMoment.findFirst({
        where: {
          id: input.source.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          physicalMaterialized: false,
          indexRun: { active: true },
        },
        include: {
          sourceArtifact: { include: { currentRightsSnapshot: true } },
        },
      })
      if (!moment?.sourceArtifact.currentRightsSnapshot) return null
      const people = stringArray(
        moment.speakerIdsJson,
        'moment speaker IDs',
      )
      const roles = stringArray(moment.rolesJson, 'moment roles')
      const tags = stringArray(moment.tagsJson, 'moment tags')
      return Object.freeze({
        source: Object.freeze({
          type: 'long-form-moment' as const,
          id: moment.id,
          hash: moment.momentHash,
          artifactId: moment.sourceArtifactId,
          artifactSha256: moment.sourceArtifact.sha256,
        }),
        kind: 'long-form-moment' as const,
        durationMs:
          moment.recommendedEndMs - moment.recommendedStartMs,
        locale,
        personIds: people,
        transcriptText: observedValue(moment.keyQuoteJson),
        intentions: canonicalTokens([...roles, ...tags]),
        description: [
          observedValue(moment.topicJson),
          observedValue(moment.summaryJson),
        ].filter(Boolean).join('\n'),
        metadata: Object.freeze({
          'chapter-id': moment.chapterId,
          salience: moment.salience.toString(),
          'hook-potential': moment.hookPotential.toString(),
        }),
        rights: currentRights(
          moment.sourceArtifact.currentRightsSnapshot,
        ),
      })
    }
    const validated = await this.client.v2ValidatedSegment.findFirst({
      where: {
        id: input.source.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        physicalMaterialized: false,
        causalClaimAllowed: false,
      },
      include: {
        sourceArtifact: { include: { currentRightsSnapshot: true } },
      },
    })
    if (!validated?.sourceArtifact.currentRightsSnapshot) return null
    const envelope = record(
      parseJson(
        validated.protectedEnvelopeJson,
        'validated envelope',
      ),
      'validated envelope',
    )
    const validationSource = record(
      parseJson(validated.sourceJson, 'validation source'),
      'validation source',
    )
    const performance = record(
      parseJson(validated.performanceJson, 'validation performance'),
      'validation performance',
    )
    const range = envelope.sourceRangeMs
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every((value) => Number.isSafeInteger(value))
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored validation envelope range is invalid',
      )
    }
    const speakerId =
      typeof envelope.speakerId === 'string'
        ? envelope.speakerId
        : undefined
    return Object.freeze({
      source: Object.freeze({
        type: 'validated-segment' as const,
        id: validated.id,
        hash: validated.validatedSegmentHash,
        artifactId: validated.sourceArtifactId,
        artifactSha256: validated.sourceArtifact.sha256,
      }),
      kind: 'validated-segment' as const,
      durationMs: Number(range[1]) - Number(range[0]),
      locale,
      personIds: Object.freeze(speakerId ? [speakerId] : []),
      transcriptText:
        typeof envelope.exactCopy === 'string'
          ? envelope.exactCopy
          : '',
      intentions: canonicalTokens([
        validated.scopeUnit,
        validated.evidenceScope,
        typeof performance.metric === 'string'
          ? performance.metric
          : '',
      ].filter(Boolean)),
      description: [
        typeof validationSource.platform === 'string'
          ? validationSource.platform
          : '',
        typeof validationSource.publicationRef === 'string'
          ? validationSource.publicationRef
          : '',
      ].filter(Boolean).join('\n'),
      metadata: Object.freeze({
        'scope-unit': validated.scopeUnit,
        'evidence-scope': validated.evidenceScope,
        platform:
          typeof validationSource.platform === 'string'
            ? validationSource.platform
            : 'unknown',
      }),
      rights: currentRights(
        validated.sourceArtifact.currentRightsSnapshot,
      ),
    })
  }

  async findIdempotentDocument(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2SemanticSearchDocument.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: input,
      },
    })
    return row ? hydrateDocument(row) : null
  }

  async persistDocument(
    document: Readonly<PersistedSemanticSearchDocument>,
    vector: readonly number[] | null,
    attempt = 1,
  ): ReturnType<SemanticSearchRepository['persistDocument']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing =
          await transaction.v2SemanticSearchDocument.findUnique({
            where: {
              workspaceId_projectId_idempotencyKey: {
                workspaceId: document.workspaceId,
                projectId: document.projectId,
                idempotencyKey: document.idempotencyKey,
              },
            },
          })
        if (existing) {
          if (
            existing.requestFingerprint !==
            document.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different semantic document request',
            )
          }
          return Object.freeze({
            document: hydrateDocument(existing),
            replayed: true,
          })
        }
        const [artifact, actor, sourceAvailable] = await Promise.all([
          transaction.v2MediaArtifact.findFirst({
            where: {
              id: document.source.artifactId,
              workspaceId: document.workspaceId,
              sha256: document.source.artifactSha256,
              status: 'available',
              currentRightsSnapshotId: document.rightsSnapshotId,
              projectAssets: {
                some: {
                  projectId: document.projectId,
                  workspaceId: document.workspaceId,
                },
              },
            },
            include: { currentRightsSnapshot: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: document.createdBy.id,
              workspaceId: document.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
          sourceHashExists(transaction, document),
        ])
        if (
          !artifact?.currentRightsSnapshot ||
          !actor ||
          !sourceAvailable
        ) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Semantic indexing context is no longer available',
          )
        }
        if (
          artifact.currentRightsSnapshot.status !==
            document.rightsStatus ||
          artifact.currentRightsSnapshot.consentStatus !==
            document.consentStatus
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Semantic source rights changed before commit',
          )
        }
        await transaction.v2SemanticSearchDocument.updateMany({
          where: {
            workspaceId: document.workspaceId,
            projectId: document.projectId,
            identityKey: document.identityKey,
            active: true,
          },
          data: { active: false },
        })
        const data = documentData(document, vector)
        const created =
          await transaction.v2SemanticSearchDocument.create({
            data: vector
              ? {
                  ...data,
                  embeddingState: 'unavailable',
                  embeddingVectorHash: null,
                  embeddingJson: '[]',
                }
              : data,
          })
        if (vector) {
          const literal = vectorLiteral(vector)
          const serializedVector = stableSerialize(vector)
          await transaction.$executeRaw(
            Prisma.sql`
              UPDATE "semantic_search_documents"
              SET
                "embeddingState" = 'ready',
                "embeddingVectorHash" =
                  ${document.embedding.vectorHash!},
                "embeddingJson" = ${serializedVector},
                "embedding" = ${literal}::vector
              WHERE "id" = ${created.id}
                AND "workspaceId" = ${document.workspaceId}
            `,
          )
        }
        const persisted =
          await transaction.v2SemanticSearchDocument.findUniqueOrThrow({
            where: { id: created.id },
          })
        return Object.freeze({
          document: hydrateDocument(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistDocument(document, vector, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotentDocument({
          workspaceId: document.workspaceId,
          projectId: document.projectId,
          idempotencyKey: document.idempotencyKey,
        })
        if (replay) {
          if (
            replay.requestFingerprint !== document.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different semantic document request',
            )
          }
          return Object.freeze({ document: replay, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Semantic document conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async searchCandidates(
    query: Readonly<SemanticSearchCandidateQuery>,
  ) {
    const project = await this.client.v2Project.findFirst({
      where: {
        id: query.projectId,
        workspaceId: query.workspaceId,
      },
      select: { id: true },
    })
    if (!project) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    }
    const projectScope = query.query.scope === 'project'
      ? Prisma.sql`AND "projectId" = ${query.projectId}`
      : Prisma.empty
    const fullTextRows = query.normalizedQueryText
      ? await this.client.$queryRaw<
          { id: string; score: number }[]
        >(Prisma.sql`
          SELECT
            "id",
            LEAST(
              1.0,
              GREATEST(
                ts_rank_cd(
                  "searchVector",
                  websearch_to_tsquery(
                    'simple',
                    ${query.normalizedQueryText}
                  )
                ) * 4.0,
                word_similarity(
                  ${query.normalizedQueryText},
                  "searchTextNormalized"
                )
              )
            )::double precision AS "score"
          FROM "semantic_search_documents"
          WHERE "workspaceId" = ${query.workspaceId}
            ${projectScope}
            AND "active" = TRUE
          ORDER BY "score" DESC, "id" ASC
          LIMIT ${query.candidateLimit}
        `)
      : []
    const vectorRows = query.embedding
      ? await this.client.$queryRaw<
          { id: string; score: number }[]
        >(Prisma.sql`
          SELECT
            "id",
            GREATEST(
              0.0,
              LEAST(
                1.0,
                1.0 - (
                  "embedding" <=>
                  ${vectorLiteral(query.embedding.vector)}::vector
                )
              )
            )::double precision AS "score"
          FROM "semantic_search_documents"
          WHERE "workspaceId" = ${query.workspaceId}
            ${projectScope}
            AND "active" = TRUE
            AND "embeddingState" = 'ready'
            AND "embeddingProvider" =
              ${query.embedding.descriptor.provider}
            AND "embeddingModel" =
              ${query.embedding.descriptor.model}
            AND "embeddingVersion" =
              ${query.embedding.descriptor.version}
            AND "embeddingDimensions" =
              ${query.embedding.descriptor.dimensions}
          ORDER BY "embedding" <=>
            ${vectorLiteral(query.embedding.vector)}::vector
          LIMIT ${query.candidateLimit}
        `)
      : []
    const scoredIds = [
      ...new Set([
        ...fullTextRows.map((row) => row.id),
        ...vectorRows.map((row) => row.id),
      ]),
    ]
    const include = {
      sourceArtifact: {
        select: { currentRightsSnapshot: true },
      },
    } as const
    const [scored, recent] = await Promise.all([
      scoredIds.length
        ? this.client.v2SemanticSearchDocument.findMany({
            where: {
              workspaceId: query.workspaceId,
              ...(query.query.scope === 'project'
                ? { projectId: query.projectId }
                : {}),
              active: true,
              id: { in: scoredIds },
            },
            include,
          })
        : Promise.resolve([]),
      this.client.v2SemanticSearchDocument.findMany({
        where: {
          workspaceId: query.workspaceId,
          ...(query.query.scope === 'project'
            ? { projectId: query.projectId }
            : {}),
          active: true,
        },
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: query.candidateLimit,
      }),
    ])
    const byId = new Map<string, SearchRow>()
    for (const row of [...scored, ...recent] as SearchRow[]) {
      byId.set(row.id, row)
    }
    const fullTextScores = new Map(
      fullTextRows.map((row) => [row.id, row.score]),
    )
    const vectorScores = new Map(
      vectorRows.map((row) => [row.id, row.score]),
    )
    const candidates = [...byId.values()]
      .slice(0, query.candidateLimit)
      .map((row) => ({
      document: hydrateDocument(row),
      currentRights: row.sourceArtifact.currentRightsSnapshot
        ? currentRights(row.sourceArtifact.currentRightsSnapshot)
        : null,
      fullTextScore: Math.max(
        0,
        Math.min(1, fullTextScores.get(row.id) ?? 0),
      ),
      vectorScore: Math.max(
        0,
        Math.min(1, vectorScores.get(row.id) ?? 0),
      ),
      }))
    const evaluated = candidates.map((candidate) => ({
      candidate,
      rightsReasons: semanticRightsRejectionReasons({
        document: candidate.document,
        current: candidate.currentRights,
        rightsUse: query.query.rightsUse,
        now: query.evaluatedAt,
      }),
    }))
    const prefilterRejected = query.query.scope === 'workspace'
      ? evaluated
          .filter((item) => item.rightsReasons.length > 0)
          .map((item) => Object.freeze({
            documentId: item.candidate.document.id,
            identityKey: item.candidate.document.identityKey,
            reasons: item.rightsReasons,
          }))
      : []
    return Object.freeze({
      candidates: Object.freeze(
        evaluated
          .filter((item) =>
            query.query.scope !== 'workspace' ||
            item.rightsReasons.length === 0)
          .map((item) => item.candidate),
      ),
      prefilterRejected: Object.freeze(prefilterRejected),
    })
  }

  async findIdempotentEvaluation(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2RetrievalEvaluation.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: input,
      },
    })
    return row ? hydrateEvaluation(row) : null
  }

  async persistEvaluation(
    evaluation: Readonly<PersistedRetrievalEvaluation>,
    attempt = 1,
  ): ReturnType<SemanticSearchRepository['persistEvaluation']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing =
          await transaction.v2RetrievalEvaluation.findUnique({
            where: {
              workspaceId_projectId_idempotencyKey: {
                workspaceId: evaluation.workspaceId,
                projectId: evaluation.projectId,
                idempotencyKey: evaluation.idempotencyKey,
              },
            },
          })
        if (existing) {
          if (
            existing.requestFingerprint !==
            evaluation.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different retrieval evaluation',
            )
          }
          return Object.freeze({
            evaluation: hydrateEvaluation(existing),
            replayed: true,
          })
        }
        const [project, actor] = await Promise.all([
          transaction.v2Project.findFirst({
            where: {
              id: evaluation.projectId,
              workspaceId: evaluation.workspaceId,
            },
            select: { id: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: evaluation.createdBy.id,
              workspaceId: evaluation.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!project || !actor) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Retrieval evaluation context is no longer available',
          )
        }
        const created =
          await transaction.v2RetrievalEvaluation.create({
            data: evaluationData(evaluation),
          })
        return Object.freeze({
          evaluation: hydrateEvaluation(created),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistEvaluation(evaluation, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotentEvaluation({
          workspaceId: evaluation.workspaceId,
          projectId: evaluation.projectId,
          idempotencyKey: evaluation.idempotencyKey,
        })
        if (replay) {
          if (
            replay.requestFingerprint !==
            evaluation.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different retrieval evaluation',
            )
          }
          return Object.freeze({ evaluation: replay, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Retrieval evaluation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async findIdempotentReuseRun(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2SemanticReuseRun.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: input,
      },
    })
    return row ? hydrateReuseRun(row) : null
  }

  async persistReuseRun(
    run: Readonly<PersistedSemanticReuseRun>,
    attempt = 1,
  ): ReturnType<SemanticSearchRepository['persistReuseRun']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing =
          await transaction.v2SemanticReuseRun.findUnique({
            where: {
              workspaceId_projectId_idempotencyKey: {
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                idempotencyKey: run.idempotencyKey,
              },
            },
          })
        if (existing) {
          if (existing.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different semantic reuse request',
            )
          }
          return Object.freeze({
            run: hydrateReuseRun(existing),
            replayed: true,
          })
        }
        const [project, actor] = await Promise.all([
          transaction.v2Project.findFirst({
            where: {
              id: run.projectId,
              workspaceId: run.workspaceId,
            },
            select: { id: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: run.createdBy.id,
              workspaceId: run.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!project || !actor) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Semantic reuse context is no longer available',
          )
        }
        const created = await transaction.v2SemanticReuseRun.create({
          data: reuseRunData(run),
        })
        return Object.freeze({
          run: hydrateReuseRun(created),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistReuseRun(run, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotentReuseRun({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          idempotencyKey: run.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different semantic reuse request',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Semantic reuse run conflicted with another transaction',
        )
      }
      throw error
    }
  }
}
