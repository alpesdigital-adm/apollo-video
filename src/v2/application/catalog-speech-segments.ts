import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  catalogSpeechSegments,
  normalizeSpeechText,
  SPEECH_SEGMENT_CLASSIFICATIONS,
  SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
  type SpeechCatalogProducer,
  type SpeechSegmentAnnotationInput,
  type SpeechSegmentClassification,
} from '../domain/speech-segment-catalog.ts'
import type {
  PersistedSpeechCatalogRun,
  SpeechSegmentCatalogRepository,
  SpeechSegmentSearchQuery,
} from './ports/speech-segment-catalog-repository.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return (value as string).trim()
}

function expectedHash(value: unknown): string {
  assertDomain(
    typeof value === 'string' &&
      SHA_256_PATTERN.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    'expectedTranscriptHash must be SHA-256',
  )
  return value.trim().toLowerCase()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
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

function producer(input: SpeechCatalogProducer): SpeechCatalogProducer {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'producer is required',
  )
  return {
    provider: identity(input.provider, 'producer.provider'),
    model: identity(input.model, 'producer.model'),
    version: identity(input.version, 'producer.version'),
    confidence: finiteScore(input.confidence, 'producer.confidence'),
  }
}

export function calculateSpeechCatalogRunRecordHash(
  run: Omit<PersistedSpeechCatalogRun, 'recordHash' | 'active'>,
): string {
  return calculateCanonicalHash(run)
}

export function catalogSpeechSegmentsService(dependencies: {
  repository: SpeechSegmentCatalogRepository
  clock: () => Date
  createId: (
    kind: 'speech-catalog-run' | 'speech-segment',
    sourceSegmentId?: number,
  ) => string
}) {
  return async function catalog(request: {
    workspaceId: string
    projectId: string
    sourceTranscriptId: string
    expectedTranscriptHash: string
    extractionPolicyVersion: string
    producer: SpeechCatalogProducer
    annotations: readonly Readonly<SpeechSegmentAnnotationInput>[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sourceTranscriptId = identity(
      request.sourceTranscriptId,
      'sourceTranscriptId',
    )
    const transcriptHash = expectedHash(request.expectedTranscriptHash)
    assertDomain(
      request.extractionPolicyVersion ===
        SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `extractionPolicyVersion must be ${SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION}`,
    )
    assertDomain(
      Array.isArray(request.annotations) && request.annotations.length <= 100_000,
      'INVALID_ARGUMENT',
      'annotations must contain at most 100000 entries',
    )
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'Speech catalog requires an authenticated API client',
    )
    const actorId = identity(request.actor.id, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const catalogProducer = producer(request.producer)
    const annotations = Object.freeze(
      request.annotations.map((annotation) => Object.freeze(annotation)),
    )
    const annotationsHash = calculateCanonicalHash(annotations)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'catalog-speech-segments-request/v1',
      workspaceId,
      projectId,
      sourceTranscriptId,
      expectedTranscriptHash: transcriptHash,
      extractionPolicyVersion: SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
      producer: catalogProducer,
      annotations,
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different speech catalog request',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }

    const context = await dependencies.repository.readExtractionContext({
      workspaceId,
      projectId,
      sourceTranscriptId,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Project transcript was not found',
      )
    }
    if (context.transcript.transcriptHash !== transcriptHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Transcript changed before speech catalog extraction',
        {
          currentTranscriptHash: context.transcript.transcriptHash,
        },
      )
    }
    const now = dependencies.clock()
    assertDomain(
      !Number.isNaN(now.getTime()),
      'INVALID_ARGUMENT',
      'Speech catalog clock is invalid',
    )
    const createdAt = now.toISOString()
    const runId = identity(
      dependencies.createId('speech-catalog-run'),
      'catalogRunId',
    )
    const segments = catalogSpeechSegments({
      workspaceId,
      projectId,
      catalogRunId: runId,
      sourceTranscriptId,
      sourceArtifactId: context.sourceArtifactId,
      transcript: context.transcript,
      annotations,
      producer: catalogProducer,
      createdAt,
      createSegmentId: (sourceSegmentId) =>
        dependencies.createId('speech-segment', sourceSegmentId),
    })
    const content = Object.freeze({
      schemaVersion: 'speech-segment-catalog-run/v1' as const,
      id: runId,
      workspaceId,
      projectId,
      sourceTranscriptId,
      sourceTranscriptHash: transcriptHash,
      sourceArtifactId: context.sourceArtifactId,
      extractionPolicyVersion: SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
      producer: Object.freeze(catalogProducer),
      annotations,
      annotationsHash,
      segments,
      segmentCount: segments.length,
      requestFingerprint,
      idempotencyKey: key,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      createdAt,
    })
    const run = Object.freeze({
      ...content,
      recordHash: calculateSpeechCatalogRunRecordHash(content),
      active: true,
    })
    return dependencies.repository.persist(run)
  }
}

function optionalSearchText(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  assertDomain(
    typeof value === 'string' &&
      value.trim().length >= 1 &&
      value.trim().length <= 240,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const normalized = normalizeSpeechText(value.trim())
  assertDomain(
    normalized.length > 0,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

export function searchSpeechSegmentsService(dependencies: {
  repository: SpeechSegmentCatalogRepository
}) {
  return async function search(request: {
    workspaceId: string
    projectId: string
    text?: string
    intention?: string
    speakerId?: string
    emotion?: string
    expression?: string
    wardrobe?: string
    setting?: string
    sourceArtifactId?: string
    classification?: SpeechSegmentClassification
    completeThoughtMin?: number
    limit?: number
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    if (request.classification !== undefined) {
      assertDomain(
        SPEECH_SEGMENT_CLASSIFICATIONS.includes(request.classification),
        'INVALID_ARGUMENT',
        'classification is invalid',
      )
    }
    if (request.completeThoughtMin !== undefined) {
      finiteScore(request.completeThoughtMin, 'completeThoughtMin')
    }
    const query: SpeechSegmentSearchQuery = {
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      limit,
      ...(optionalSearchText(request.text, 'q')
        ? { text: optionalSearchText(request.text, 'q') }
        : {}),
      ...(optionalSearchText(request.intention, 'intention')
        ? { intention: optionalSearchText(request.intention, 'intention') }
        : {}),
      ...(optionalSearchText(request.speakerId, 'speakerId')
        ? { speakerId: optionalSearchText(request.speakerId, 'speakerId') }
        : {}),
      ...(optionalSearchText(request.emotion, 'emotion')
        ? { emotion: optionalSearchText(request.emotion, 'emotion') }
        : {}),
      ...(optionalSearchText(request.expression, 'expression')
        ? { expression: optionalSearchText(request.expression, 'expression') }
        : {}),
      ...(optionalSearchText(request.wardrobe, 'wardrobe')
        ? { wardrobe: optionalSearchText(request.wardrobe, 'wardrobe') }
        : {}),
      ...(optionalSearchText(request.setting, 'setting')
        ? { setting: optionalSearchText(request.setting, 'setting') }
        : {}),
      ...(request.sourceArtifactId
        ? {
            sourceArtifactId: identity(
              request.sourceArtifactId,
              'sourceArtifactId',
            ),
          }
        : {}),
      ...(request.classification
        ? { classification: request.classification }
        : {}),
      ...(request.completeThoughtMin !== undefined
        ? { completeThoughtMin: request.completeThoughtMin }
        : {}),
    }
    return dependencies.repository.search(query)
  }
}
