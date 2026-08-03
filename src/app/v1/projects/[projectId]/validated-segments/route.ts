import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  catalogValidatedSegmentService,
  searchValidatedSegmentsService,
} from '@/v2/application/catalog-validated-segments'
import { DomainError } from '@/v2/domain/errors'
import {
  VALIDATED_SEGMENT_POLICY_VERSION,
  type ValidationPerformanceEvidence,
  type ValidationScope,
  type ValidationSource,
} from '@/v2/domain/validated-segment'
import { createValidatedSegmentRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const BODY_FIELDS = new Set([
  'sourceArtifactId',
  'expectedArtifactSha256',
  'sourceManifestId',
  'expectedManifestHash',
  'sourceSpeechSegmentId',
  'expectedSpeechSegmentHash',
  'policyVersion',
  'scope',
  'source',
  'performance',
  'validatedAt',
  'expiresAt',
])
const SCOPE_FIELDS = new Set(['unit', 'evidenceScope'])
const SOURCE_FIELDS = new Set([
  'platform',
  'publicationRef',
  'accountRef',
  'url',
  'observedAt',
])
const PERFORMANCE_FIELDS = new Set([
  'metric',
  'value',
  'unit',
  'sampleSize',
  'period',
  'comparison',
])
const PERIOD_FIELDS = new Set(['start', 'end'])
const COMPARISON_FIELDS = new Set(['label', 'value', 'unit'])

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

function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a string`)
  }
  return value
}

function scope(value: unknown): ValidationScope {
  const input = record(value, 'scope')
  exactFields(input, SCOPE_FIELDS, 'scope')
  if (
    !['hook', 'segment', 'whole-video'].includes(String(input.unit)) ||
    !['copy', 'spoken-take', 'opening-edit'].includes(
      String(input.evidenceScope),
    )
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'scope is invalid')
  }
  return {
    unit: input.unit as ValidationScope['unit'],
    evidenceScope:
      input.evidenceScope as ValidationScope['evidenceScope'],
  }
}

function source(value: unknown): ValidationSource {
  const input = record(value, 'source')
  exactFields(input, SOURCE_FIELDS, 'source')
  if (
    typeof input.platform !== 'string' ||
    typeof input.publicationRef !== 'string' ||
    typeof input.observedAt !== 'string'
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'source is invalid')
  }
  return {
    platform: input.platform,
    publicationRef: input.publicationRef,
    ...(input.accountRef !== undefined
      ? { accountRef: optionalString(input.accountRef, 'source.accountRef') }
      : {}),
    ...(input.url !== undefined
      ? { url: optionalString(input.url, 'source.url') }
      : {}),
    observedAt: input.observedAt,
  }
}

function performance(
  value: unknown,
): ValidationPerformanceEvidence {
  const input = record(value, 'performance')
  exactFields(input, PERFORMANCE_FIELDS, 'performance')
  const period = record(input.period, 'performance.period')
  exactFields(period, PERIOD_FIELDS, 'performance.period')
  if (
    typeof input.metric !== 'string' ||
    typeof input.value !== 'number' ||
    typeof input.unit !== 'string' ||
    typeof input.sampleSize !== 'number' ||
    typeof period.start !== 'string' ||
    typeof period.end !== 'string'
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'performance is invalid')
  }
  let comparison:
    | ValidationPerformanceEvidence['comparison']
    | undefined
  if (input.comparison !== undefined) {
    const candidate = record(
      input.comparison,
      'performance.comparison',
    )
    exactFields(
      candidate,
      COMPARISON_FIELDS,
      'performance.comparison',
    )
    if (
      typeof candidate.label !== 'string' ||
      typeof candidate.value !== 'number' ||
      typeof candidate.unit !== 'string'
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'performance.comparison is invalid',
      )
    }
    comparison = {
      label: candidate.label,
      value: candidate.value,
      unit:
        candidate.unit as ValidationPerformanceEvidence['unit'],
    }
  }
  return {
    metric: input.metric,
    value: input.value,
    unit: input.unit as ValidationPerformanceEvidence['unit'],
    sampleSize: input.sampleSize,
    period: {
      start: period.start,
      end: period.end,
    },
    ...(comparison ? { comparison } : {}),
  }
}

function strictBody(value: unknown) {
  const body = record(value, 'Request body')
  exactFields(body, BODY_FIELDS, 'Request body')
  if (
    typeof body.sourceArtifactId !== 'string' ||
    typeof body.expectedArtifactSha256 !== 'string' ||
    typeof body.sourceManifestId !== 'string' ||
    typeof body.expectedManifestHash !== 'string' ||
    body.policyVersion !== VALIDATED_SEGMENT_POLICY_VERSION ||
    typeof body.validatedAt !== 'string'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'ValidatedSegment request is invalid',
    )
  }
  return {
    sourceArtifactId: body.sourceArtifactId,
    expectedArtifactSha256: body.expectedArtifactSha256,
    sourceManifestId: body.sourceManifestId,
    expectedManifestHash: body.expectedManifestHash,
    ...(body.sourceSpeechSegmentId !== undefined
      ? {
          sourceSpeechSegmentId: optionalString(
            body.sourceSpeechSegmentId,
            'sourceSpeechSegmentId',
          ),
        }
      : {}),
    ...(body.expectedSpeechSegmentHash !== undefined
      ? {
          expectedSpeechSegmentHash: optionalString(
            body.expectedSpeechSegmentHash,
            'expectedSpeechSegmentHash',
          ),
        }
      : {}),
    policyVersion: VALIDATED_SEGMENT_POLICY_VERSION,
    scope: scope(body.scope),
    source: source(body.source),
    performance: performance(body.performance),
    validatedAt: body.validatedAt,
    ...(body.expiresAt !== undefined
      ? {
          expiresAt: optionalString(body.expiresAt, 'expiresAt'),
        }
      : {}),
  }
}

function presentSegment<T extends {
  requestFingerprint: string
  idempotencyKey: string
}>(segment: T) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...publicSegment
  } = segment
  return publicSegment
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
    const result = await catalogValidatedSegmentService({
      repository: createValidatedSegmentRepository(),
      clock: () => new Date(),
      createId: () => `validated-segment-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        segment: presentSegment(result.segment),
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
  'sourceArtifactId',
  'platform',
  'unit',
  'evidenceScope',
  'metric',
  'activeOnly',
  'limit',
])

function booleanParameter(value: string | null, field: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new DomainError(
    'INVALID_ARGUMENT',
    `${field} must be true or false`,
  )
}

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
          `${name} is not a supported validation search parameter`,
        )
      }
    }
    const { projectId } = await context.params
    const results = await searchValidatedSegmentsService({
      repository: createValidatedSegmentRepository(),
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(params.has('q')
        ? { text: params.get('q') ?? undefined }
        : {}),
      ...(params.has('sourceArtifactId')
        ? {
            sourceArtifactId:
              params.get('sourceArtifactId') ?? undefined,
          }
        : {}),
      ...(params.has('platform')
        ? { platform: params.get('platform') ?? undefined }
        : {}),
      ...(params.has('unit')
        ? { unit: params.get('unit') ?? undefined }
        : {}),
      ...(params.has('evidenceScope')
        ? {
            evidenceScope:
              params.get('evidenceScope') ?? undefined,
          }
        : {}),
      ...(params.has('metric')
        ? { metric: params.get('metric') ?? undefined }
        : {}),
      ...(params.has('activeOnly')
        ? {
            activeOnly: booleanParameter(
              params.get('activeOnly'),
              'activeOnly',
            ),
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
          currentRightsSnapshotId: result.currentRights?.id,
          currentRightsStatus: result.currentRights?.status ?? 'unknown',
          currentConsentStatus:
            result.currentRights?.consentStatus ?? 'unknown',
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
