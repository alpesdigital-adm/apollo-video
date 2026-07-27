import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  catalogEvidenceSegmentService,
  searchEvidenceSegmentsService,
} from '@/v2/application/catalog-evidence-segments'
import {
  EVIDENCE_CATEGORIES,
  type EvidenceCategory,
  type EvidenceObservationInput,
  type EvidenceProducer,
} from '@/v2/domain/evidence-segment'
import { DomainError } from '@/v2/domain/errors'
import { createEvidenceSegmentRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const BODY_FIELDS = new Set([
  'sourceSpeechSegmentId',
  'expectedSpeechSegmentHash',
  'category',
  'claim',
  'result',
  'context',
  'qualifiers',
  'subject',
  'attribution',
  'compatibleOfferIds',
  'compatibleAudienceTags',
  'compatibleObjections',
  'credibilityScore',
  'specificityScore',
  'authenticityScore',
  'contextRangeMs',
  'frameRefs',
  'adjacentEvidenceIds',
  'requiresContext',
  'producer',
])
const OBSERVATION_FIELDS = new Set(['value', 'confidence'])
const PRODUCER_FIELDS = new Set([
  'provider',
  'model',
  'version',
  'confidence',
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
): EvidenceObservationInput {
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

function producer(value: unknown): EvidenceProducer {
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

function strings(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an array of strings`,
    )
  }
  return value as string[]
}

function range(value: unknown): readonly [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(Number.isSafeInteger)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'contextRangeMs must contain two integers',
    )
  }
  return value as [number, number]
}

function strictBody(value: unknown) {
  const body = record(value, 'Request body')
  exactFields(body, BODY_FIELDS, 'Request body')
  if (
    typeof body.sourceSpeechSegmentId !== 'string' ||
    typeof body.expectedSpeechSegmentHash !== 'string' ||
    typeof body.category !== 'string' ||
    !EVIDENCE_CATEGORIES.includes(body.category as EvidenceCategory) ||
    !Array.isArray(body.qualifiers) ||
    typeof body.credibilityScore !== 'number' ||
    typeof body.specificityScore !== 'number' ||
    typeof body.authenticityScore !== 'number' ||
    typeof body.requiresContext !== 'boolean'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Evidence segment catalog request is invalid',
    )
  }
  return {
    sourceSpeechSegmentId: body.sourceSpeechSegmentId,
    expectedSpeechSegmentHash: body.expectedSpeechSegmentHash,
    category: body.category as EvidenceCategory,
    claim: observation(body.claim, 'claim'),
    ...(body.result !== undefined
      ? { result: observation(body.result, 'result') }
      : {}),
    context: observation(body.context, 'context'),
    qualifiers: body.qualifiers.map((item, index) =>
      observation(item, `qualifiers[${index}]`)),
    subject: observation(body.subject, 'subject'),
    attribution: observation(body.attribution, 'attribution'),
    compatibleOfferIds: strings(
      body.compatibleOfferIds,
      'compatibleOfferIds',
    ),
    compatibleAudienceTags: strings(
      body.compatibleAudienceTags,
      'compatibleAudienceTags',
    ),
    compatibleObjections: strings(
      body.compatibleObjections,
      'compatibleObjections',
    ),
    credibilityScore: body.credibilityScore,
    specificityScore: body.specificityScore,
    authenticityScore: body.authenticityScore,
    contextRangeMs: range(body.contextRangeMs),
    frameRefs: strings(body.frameRefs, 'frameRefs'),
    adjacentEvidenceIds: strings(
      body.adjacentEvidenceIds,
      'adjacentEvidenceIds',
    ),
    requiresContext: body.requiresContext,
    producer: producer(body.producer),
  }
}

function presentEvidence(
  evidence: Awaited<
    ReturnType<ReturnType<typeof catalogEvidenceSegmentService>>
  >['evidence'],
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...publicEvidence
  } = evidence
  return publicEvidence
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
    const result = await catalogEvidenceSegmentService({
      repository: createEvidenceSegmentRepository(),
      clock: () => new Date(),
      createId: () => `evidence-segment-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        evidence: presentEvidence(result.evidence),
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
  'category',
  'subject',
  'attribution',
  'sourceSpeechSegmentId',
  'offerId',
  'objection',
  'intendedClaim',
  'includedContext',
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
          `${name} is not a supported evidence search parameter`,
        )
      }
    }
    const category = params.get('category') ?? undefined
    if (
      category !== undefined &&
      !EVIDENCE_CATEGORIES.includes(category as EvidenceCategory)
    ) {
      throw new DomainError('INVALID_ARGUMENT', 'category is invalid')
    }
    const includedContext = params.get('includedContext')
    if (
      includedContext !== null &&
      includedContext !== 'true' &&
      includedContext !== 'false'
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'includedContext must be true or false',
      )
    }
    const { projectId } = await context.params
    const results = await searchEvidenceSegmentsService({
      repository: createEvidenceSegmentRepository(),
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(params.has('q') ? { text: params.get('q') ?? undefined } : {}),
      ...(category ? { category: category as EvidenceCategory } : {}),
      ...(params.has('subject')
        ? { subject: params.get('subject') ?? undefined }
        : {}),
      ...(params.has('attribution')
        ? { attribution: params.get('attribution') ?? undefined }
        : {}),
      ...(params.has('sourceSpeechSegmentId')
        ? {
            sourceSpeechSegmentId:
              params.get('sourceSpeechSegmentId') ?? undefined,
          }
        : {}),
      ...(params.has('offerId')
        ? { offerId: params.get('offerId') ?? undefined }
        : {}),
      ...(params.has('objection')
        ? { objection: params.get('objection') ?? undefined }
        : {}),
      ...(params.has('intendedClaim')
        ? { intendedClaim: params.get('intendedClaim') ?? undefined }
        : {}),
      ...(includedContext !== null
        ? { includedContext: includedContext === 'true' }
        : {}),
      ...(params.has('limit')
        ? { limit: Number(params.get('limit')) }
        : {}),
    })
    return NextResponse.json(
      presentSuccess({
        results: results.map((result) => ({
          evidence: presentEvidence(result.evidence),
          matchedBy: result.matchedBy,
          reuseDecision: result.reuseDecision,
        })),
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
