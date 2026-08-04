import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  catalogSpeechSegmentsService,
  searchSpeechSegmentsService,
} from '@/v2/application/catalog-speech-segments'
import { DomainError } from '@/v2/domain/errors'
import {
  SPEECH_SEGMENT_CLASSIFICATIONS,
  type SpeechCatalogObservedInput,
  type SpeechCatalogProducer,
  type SpeechSegmentAnnotationInput,
  type SpeechSegmentClassification,
} from '@/v2/domain/speech-segment-catalog'
import {
  createSpeechSegmentCatalogRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const BODY_FIELDS = new Set([
  'sourceTranscriptId',
  'expectedTranscriptHash',
  'extractionPolicyVersion',
  'producer',
  'annotations',
])
const PRODUCER_FIELDS = new Set([
  'provider',
  'model',
  'version',
  'confidence',
])
const ANNOTATION_FIELDS = new Set([
  'sourceSegmentId',
  'speaker',
  'visual',
  'intentions',
])
const OBSERVATION_FIELDS = new Set(['value', 'confidence'])
const VISUAL_FIELDS = new Set([
  'emotion',
  'expression',
  'wardrobe',
  'setting',
  'colors',
])

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
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

function observation(
  value: unknown,
  field: string,
): SpeechCatalogObservedInput {
  const input = record(value, field)
  exactFields(input, OBSERVATION_FIELDS, field)
  if (
    typeof input.value !== 'string' ||
    typeof input.confidence !== 'number'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain value and confidence`,
    )
  }
  return {
    value: input.value,
    confidence: input.confidence,
  }
}

function producer(value: unknown): SpeechCatalogProducer {
  const input = record(value, 'producer')
  exactFields(input, PRODUCER_FIELDS, 'producer')
  if (
    typeof input.provider !== 'string' ||
    typeof input.model !== 'string' ||
    typeof input.version !== 'string' ||
    typeof input.confidence !== 'number'
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'producer is invalid')
  }
  return {
    provider: input.provider,
    model: input.model,
    version: input.version,
    confidence: input.confidence,
  }
}

function annotation(
  value: unknown,
  index: number,
): SpeechSegmentAnnotationInput {
  const field = `annotations[${index}]`
  const input = record(value, field)
  exactFields(input, ANNOTATION_FIELDS, field)
  if (!Number.isInteger(input.sourceSegmentId)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.sourceSegmentId must be an integer`,
    )
  }
  let visual: SpeechSegmentAnnotationInput['visual']
  if (input.visual !== undefined) {
    const visualInput = record(input.visual, `${field}.visual`)
    exactFields(visualInput, VISUAL_FIELDS, `${field}.visual`)
    if (
      visualInput.colors !== undefined &&
      !Array.isArray(visualInput.colors)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `${field}.visual.colors must be an array`,
      )
    }
    visual = {
      ...(visualInput.emotion !== undefined
        ? {
            emotion: observation(
              visualInput.emotion,
              `${field}.visual.emotion`,
            ),
          }
        : {}),
      ...(visualInput.expression !== undefined
        ? {
            expression: observation(
              visualInput.expression,
              `${field}.visual.expression`,
            ),
          }
        : {}),
      ...(visualInput.wardrobe !== undefined
        ? {
            wardrobe: observation(
              visualInput.wardrobe,
              `${field}.visual.wardrobe`,
            ),
          }
        : {}),
      ...(visualInput.setting !== undefined
        ? {
            setting: observation(
              visualInput.setting,
              `${field}.visual.setting`,
            ),
          }
        : {}),
      ...(Array.isArray(visualInput.colors)
        ? {
            colors: visualInput.colors.map((color, colorIndex) =>
              observation(
                color,
                `${field}.visual.colors[${colorIndex}]`,
              )),
          }
        : {}),
    }
  }
  if (
    input.intentions !== undefined &&
    !Array.isArray(input.intentions)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.intentions must be an array`,
    )
  }
  return {
    sourceSegmentId: input.sourceSegmentId as number,
    ...(input.speaker !== undefined
      ? { speaker: observation(input.speaker, `${field}.speaker`) }
      : {}),
    ...(visual ? { visual } : {}),
    ...(Array.isArray(input.intentions)
      ? {
          intentions: input.intentions.map((intention, intentionIndex) =>
            observation(
              intention,
              `${field}.intentions[${intentionIndex}]`,
            )),
        }
      : {}),
  }
}

function strictBody(value: unknown): {
  sourceTranscriptId: string
  expectedTranscriptHash: string
  extractionPolicyVersion: string
  producer: SpeechCatalogProducer
  annotations: readonly SpeechSegmentAnnotationInput[]
} {
  const body = record(value, 'Request body')
  exactFields(body, BODY_FIELDS, 'Request body')
  if (
    typeof body.sourceTranscriptId !== 'string' ||
    typeof body.expectedTranscriptHash !== 'string' ||
    typeof body.extractionPolicyVersion !== 'string' ||
    !Array.isArray(body.annotations)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Speech segment catalog request is invalid',
    )
  }
  return {
    sourceTranscriptId: body.sourceTranscriptId,
    expectedTranscriptHash: body.expectedTranscriptHash,
    extractionPolicyVersion: body.extractionPolicyVersion,
    producer: producer(body.producer),
    annotations: body.annotations.map(annotation),
  }
}

function presentSegment(
  segment: Awaited<
    ReturnType<ReturnType<typeof catalogSpeechSegmentsService>>
  >['run']['segments'][number],
) {
  return {
    schemaVersion: segment.schemaVersion,
    id: segment.id,
    workspaceId: segment.workspaceId,
    projectId: segment.projectId,
    catalogRunId: segment.catalogRunId,
    sourceTranscriptId: segment.sourceTranscriptId,
    sourceTranscriptHash: segment.sourceTranscriptHash,
    sourceArtifactId: segment.sourceArtifactId,
    sourceSegmentId: segment.sourceSegmentId,
    exactText: segment.exactText,
    normalizedText: segment.normalizedText,
    words: segment.words,
    speaker: segment.speaker,
    speakerId: segment.speakerId,
    rangeMs: segment.rangeMs,
    completeThoughtScore: segment.completeThoughtScore,
    classification: segment.classification,
    visual: segment.visual,
    intentions: segment.intentions,
    extractionProvenance: segment.extractionProvenance,
    extractionPolicyVersion: segment.extractionPolicyVersion,
    physicalMaterialized: segment.physicalMaterialized,
    createdAt: segment.createdAt,
    segmentHash: segment.segmentHash,
  }
}

function presentRun(
  run: Awaited<
    ReturnType<ReturnType<typeof catalogSpeechSegmentsService>>
  >['run'],
) {
  return {
    schemaVersion: run.schemaVersion,
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    sourceTranscriptId: run.sourceTranscriptId,
    sourceTranscriptHash: run.sourceTranscriptHash,
    sourceArtifactId: run.sourceArtifactId,
    extractionPolicyVersion: run.extractionPolicyVersion,
    producer: run.producer,
    annotationsHash: run.annotationsHash,
    segments: run.segments.map(presentSegment),
    segmentCount: run.segmentCount,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    recordHash: run.recordHash,
    active: run.active,
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey =
      request.headers.get('idempotency-key')?.trim() ?? ''
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = strictBody(rawBody)
    const { projectId } = await context.params
    const result = await catalogSpeechSegmentsService({
      repository: createSpeechSegmentCatalogRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      sourceTranscriptId: body.sourceTranscriptId,
      expectedTranscriptHash: body.expectedTranscriptHash,
      extractionPolicyVersion: body.extractionPolicyVersion,
      producer: body.producer,
      annotations: body.annotations,
      actor,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        run: presentRun(result.run),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

const SEARCH_FIELDS = new Set([
  'q',
  'intention',
  'speakerId',
  'emotion',
  'expression',
  'wardrobe',
  'setting',
  'sourceArtifactId',
  'classification',
  'completeThoughtMin',
  'limit',
])

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (!SEARCH_FIELDS.has(name) || params.getAll(name).length > 1) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          `${name} is not a supported speech segment search parameter`,
        )
      }
    }
    const { projectId } = await context.params
    const classification = params.get('classification') ?? undefined
    if (
      classification !== undefined &&
      !SPEECH_SEGMENT_CLASSIFICATIONS.includes(
        classification as SpeechSegmentClassification,
      )
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'classification is invalid',
      )
    }
    const results = await searchSpeechSegmentsService({
      repository: createSpeechSegmentCatalogRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(params.has('q') ? { text: params.get('q') ?? undefined } : {}),
      ...(params.has('intention')
        ? { intention: params.get('intention') ?? undefined }
        : {}),
      ...(params.has('speakerId')
        ? { speakerId: params.get('speakerId') ?? undefined }
        : {}),
      ...(params.has('emotion')
        ? { emotion: params.get('emotion') ?? undefined }
        : {}),
      ...(params.has('expression')
        ? { expression: params.get('expression') ?? undefined }
        : {}),
      ...(params.has('wardrobe')
        ? { wardrobe: params.get('wardrobe') ?? undefined }
        : {}),
      ...(params.has('setting')
        ? { setting: params.get('setting') ?? undefined }
        : {}),
      ...(params.has('sourceArtifactId')
        ? {
            sourceArtifactId:
              params.get('sourceArtifactId') ?? undefined,
          }
        : {}),
      ...(classification
        ? {
            classification:
              classification as SpeechSegmentClassification,
          }
        : {}),
      ...(params.has('completeThoughtMin')
        ? {
            completeThoughtMin:
              Number(params.get('completeThoughtMin')),
          }
        : {}),
      ...(params.has('limit')
        ? { limit: Number(params.get('limit')) }
        : {}),
    })
    return NextResponse.json(
      presentSuccess({
        results: results.map((result) => ({
          segment: presentSegment(result.segment),
          matchedBy: result.matchedBy,
          rightsStatus: result.rightsStatus,
          eligibleForReuse: result.eligibleForReuse,
          blockedReasons: result.blockedReasons,
        })),
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
