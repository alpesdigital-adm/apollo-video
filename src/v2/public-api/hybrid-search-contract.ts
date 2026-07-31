import type {
  CatalogedSemanticSearchDocument,
  HybridSearchFilters,
  HybridSearchScope,
  SemanticSearchObservationInput,
} from '../domain/hybrid-search.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  PersistedRetrievalEvaluation,
  PersistedSemanticSearchDocument,
  PersistedSemanticReuseRun,
  SemanticSearchSourceRef,
} from '../application/ports/semantic-search-repository.ts'

const CATALOG_FIELDS = new Set([
  'source',
  'expectedSourceHash',
  'indexVersion',
  'observations',
])
const SOURCE_FIELDS = new Set(['type', 'id'])
const OBSERVATION_FIELDS = new Set([
  'ocrText',
  'description',
  'intentions',
  'personIds',
  'metadata',
  'producer',
])
const PRODUCER_FIELDS = new Set([
  'provider',
  'model',
  'version',
  'confidence',
])
const QUERY_FIELDS = new Set([
  'scope',
  'text',
  'intention',
  'atmosphere',
  'personIds',
  'speech',
  'visual',
  'rightsUse',
  'filters',
  'includeBlocked',
  'limit',
  'explain',
])
const EVALUATION_QUERY_FIELDS = new Set([
  'scope',
  'text',
  'intention',
  'atmosphere',
  'personIds',
  'speech',
  'visual',
  'rightsUse',
  'filters',
  'includeBlocked',
])
const FILTER_FIELDS = new Set([
  'kinds',
  'personIds',
  'minDurationMs',
  'maxDurationMs',
  'locale',
  'metadata',
  'rights',
])
const EVALUATION_FIELDS = new Set(['k', 'cases'])
const EVALUATION_CASE_FIELDS = new Set([
  'id',
  'query',
  'relevantIdentityKeys',
])
const REUSE_RUN_FIELDS = new Set([
  'query',
  'expectedQueryHash',
  'expectedResultSetHash',
  'reusedIdentityKeys',
  'directorRejections',
])
const DIRECTOR_REJECTION_FIELDS = new Set([
  'identityKey',
  'reason',
])

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
      'INVALID_ARGUMENT',
      `${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains an unsupported field`,
    )
  }
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a string`,
    )
  }
  return value
}

function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined
    ? undefined
    : stringValue(value, field)
}

function stringArray(
  value: unknown,
  field: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an array of strings`,
    )
  }
  return value
}

function optionalStringArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  return value === undefined
    ? undefined
    : stringArray(value, field)
}

function stringMap(
  value: unknown,
  field: string,
): Readonly<Record<string, string>> {
  const input = record(value, field)
  if (
    !Object.values(input).every(
      (item) => typeof item === 'string',
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} values must be strings`,
    )
  }
  return input as Record<string, string>
}

function optionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be boolean`,
    )
  }
  return value
}

function optionalNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a number`,
    )
  }
  return value
}

function source(value: unknown): SemanticSearchSourceRef {
  const input = record(value, 'source')
  exactFields(input, SOURCE_FIELDS, 'source')
  return {
    type: stringValue(
      input.type,
      'source.type',
    ) as SemanticSearchSourceRef['type'],
    id: stringValue(input.id, 'source.id'),
  }
}

function observations(
  value: unknown,
): SemanticSearchObservationInput {
  const input = record(value, 'observations')
  exactFields(input, OBSERVATION_FIELDS, 'observations')
  const producer = record(
    input.producer,
    'observations.producer',
  )
  exactFields(
    producer,
    PRODUCER_FIELDS,
    'observations.producer',
  )
  if (typeof producer.confidence !== 'number') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'observations.producer.confidence must be a number',
    )
  }
  return {
    ...(input.ocrText !== undefined
      ? {
          ocrText: stringValue(
            input.ocrText,
            'observations.ocrText',
          ),
        }
      : {}),
    ...(input.description !== undefined
      ? {
          description: stringValue(
            input.description,
            'observations.description',
          ),
        }
      : {}),
    ...(input.intentions !== undefined
      ? {
          intentions: stringArray(
            input.intentions,
            'observations.intentions',
          ),
        }
      : {}),
    ...(input.personIds !== undefined
      ? {
          personIds: stringArray(
            input.personIds,
            'observations.personIds',
          ),
        }
      : {}),
    ...(input.metadata !== undefined
      ? {
          metadata: stringMap(
            input.metadata,
            'observations.metadata',
          ),
        }
      : {}),
    producer: {
      provider: stringValue(
        producer.provider,
        'observations.producer.provider',
      ),
      model: stringValue(
        producer.model,
        'observations.producer.model',
      ),
      version: stringValue(
        producer.version,
        'observations.producer.version',
      ),
      confidence: producer.confidence,
    },
  }
}

export function parseCatalogSemanticSearchBody(value: unknown) {
  const body = record(value, 'Request body')
  exactFields(body, CATALOG_FIELDS, 'Request body')
  return {
    source: source(body.source),
    expectedSourceHash: stringValue(
      body.expectedSourceHash,
      'expectedSourceHash',
    ),
    indexVersion: stringValue(
      body.indexVersion,
      'indexVersion',
    ),
    observations: observations(body.observations),
  }
}

function filters(value: unknown): HybridSearchFilters {
  const input = record(value, 'filters')
  exactFields(input, FILTER_FIELDS, 'filters')
  return {
    ...(input.kinds !== undefined
      ? {
          kinds: stringArray(
            input.kinds,
            'filters.kinds',
          ) as HybridSearchFilters['kinds'],
        }
      : {}),
    ...(input.personIds !== undefined
      ? {
          personIds: stringArray(
            input.personIds,
            'filters.personIds',
          ),
        }
      : {}),
    ...(input.minDurationMs !== undefined
      ? {
          minDurationMs: optionalNumber(
            input.minDurationMs,
            'filters.minDurationMs',
          ),
        }
      : {}),
    ...(input.maxDurationMs !== undefined
      ? {
          maxDurationMs: optionalNumber(
            input.maxDurationMs,
            'filters.maxDurationMs',
          ),
        }
      : {}),
    ...(input.locale !== undefined
      ? {
          locale: stringValue(
            input.locale,
            'filters.locale',
          ),
        }
      : {}),
    ...(input.metadata !== undefined
      ? {
          metadata: stringMap(
            input.metadata,
            'filters.metadata',
          ),
        }
      : {}),
    ...(input.rights !== undefined
      ? {
          rights: stringValue(
            input.rights,
            'filters.rights',
          ) as HybridSearchFilters['rights'],
        }
      : {}),
  }
}

export function parseHybridSearchQueryBody(
  value: unknown,
  options: { evaluationCase?: boolean } = {},
) {
  const field = options.evaluationCase
    ? 'evaluation query'
    : 'Request body'
  const body = record(value, field)
  exactFields(
    body,
    options.evaluationCase
      ? EVALUATION_QUERY_FIELDS
      : QUERY_FIELDS,
    field,
  )
  return {
    ...(body.scope !== undefined
      ? {
          scope: optionalString(
            body.scope,
            `${field}.scope`,
          ) as HybridSearchScope,
        }
      : {}),
    ...(body.text !== undefined
      ? { text: optionalString(body.text, `${field}.text`) }
      : {}),
    ...(body.intention !== undefined
      ? {
          intention: optionalString(
            body.intention,
            `${field}.intention`,
          ),
        }
      : {}),
    ...(body.atmosphere !== undefined
      ? {
          atmosphere: optionalString(
            body.atmosphere,
            `${field}.atmosphere`,
          ),
        }
      : {}),
    ...(body.personIds !== undefined
      ? {
          personIds: optionalStringArray(
            body.personIds,
            `${field}.personIds`,
          ),
        }
      : {}),
    ...(body.speech !== undefined
      ? {
          speech: optionalString(
            body.speech,
            `${field}.speech`,
          ),
        }
      : {}),
    ...(body.visual !== undefined
      ? {
          visual: optionalString(
            body.visual,
            `${field}.visual`,
          ),
        }
      : {}),
    rightsUse: stringValue(
      body.rightsUse,
      `${field}.rightsUse`,
    ),
    ...(body.filters !== undefined
      ? { filters: filters(body.filters) }
      : {}),
    ...(body.includeBlocked !== undefined
      ? {
          includeBlocked: optionalBoolean(
            body.includeBlocked,
            `${field}.includeBlocked`,
          ),
        }
      : {}),
    ...(!options.evaluationCase && body.limit !== undefined
      ? {
          limit: optionalNumber(
            body.limit,
            `${field}.limit`,
          ),
        }
      : {}),
    ...(!options.evaluationCase && body.explain !== undefined
      ? {
          explain: optionalBoolean(
            body.explain,
            `${field}.explain`,
          ),
        }
      : {}),
  }
}

export function parseRetrievalEvaluationBody(value: unknown) {
  const body = record(value, 'Request body')
  exactFields(body, EVALUATION_FIELDS, 'Request body')
  if (typeof body.k !== 'number' || !Array.isArray(body.cases)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Retrieval evaluation request is invalid',
    )
  }
  return {
    k: body.k,
    cases: body.cases.map((value, index) => {
      const field = `cases[${index}]`
      const input = record(value, field)
      exactFields(input, EVALUATION_CASE_FIELDS, field)
      return {
        id: stringValue(input.id, `${field}.id`),
        query: parseHybridSearchQueryBody(
          input.query,
          { evaluationCase: true },
        ),
        relevantIdentityKeys: stringArray(
          input.relevantIdentityKeys,
          `${field}.relevantIdentityKeys`,
        ),
      }
    }),
  }
}

export function parseSemanticReuseRunBody(value: unknown) {
  const body = record(value, 'Request body')
  exactFields(body, REUSE_RUN_FIELDS, 'Request body')
  if (
    !Array.isArray(body.reusedIdentityKeys) ||
    !Array.isArray(body.directorRejections)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Semantic reuse decisions must be arrays',
    )
  }
  return {
    query: parseHybridSearchQueryBody(body.query),
    expectedQueryHash: stringValue(
      body.expectedQueryHash,
      'Request body.expectedQueryHash',
    ),
    expectedResultSetHash: stringValue(
      body.expectedResultSetHash,
      'Request body.expectedResultSetHash',
    ),
    reusedIdentityKeys: stringArray(
      body.reusedIdentityKeys,
      'Request body.reusedIdentityKeys',
    ),
    directorRejections: body.directorRejections.map(
      (value, index) => {
        const field = `directorRejections[${index}]`
        const input = record(value, field)
        exactFields(input, DIRECTOR_REJECTION_FIELDS, field)
        return {
          identityKey: stringValue(
            input.identityKey,
            `${field}.identityKey`,
          ),
          reason: stringValue(
            input.reason,
            `${field}.reason`,
          ) as
            | 'narrative-mismatch'
            | 'duplicate'
            | 'quality-lower'
            | 'duration-mismatch'
            | 'continuity-risk'
            | 'not-needed',
        }
      },
    ),
  }
}

export function presentSemanticSearchDocument(
  document: Readonly<
    CatalogedSemanticSearchDocument |
    PersistedSemanticSearchDocument
  >,
) {
  const publicDocument: Record<string, unknown> = { ...document }
  delete publicDocument.requestFingerprint
  delete publicDocument.idempotencyKey
  delete publicDocument.searchTextNormalized
  return Object.freeze(publicDocument)
}

export function presentRetrievalEvaluation(
  evaluation: Readonly<PersistedRetrievalEvaluation>,
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...publicEvaluation
  } = evaluation
  return publicEvaluation
}

export function presentSemanticReuseRun(
  run: Readonly<PersistedSemanticReuseRun>,
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...publicRun
  } = run
  return publicRun
}
