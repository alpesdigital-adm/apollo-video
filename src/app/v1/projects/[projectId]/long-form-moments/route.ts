import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import {
  requireScope,
} from '@/v2/application/authenticate-api-client'
import {
  catalogLongFormMomentsService,
  searchLongFormMomentsService,
} from '@/v2/application/catalog-long-form-moments'
import { DomainError } from '@/v2/domain/errors'
import {
  LONG_FORM_INDEX_POLICY_VERSION,
  type LongFormChapterInput,
  type LongFormMomentInput,
  type LongFormObservationInput,
  type LongFormProducer,
} from '@/v2/domain/long-form-moment'
import { createLongFormIndexRepository } from '@/v2/infrastructure/repository-factory'
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
  'indexPolicyVersion',
  'producer',
  'chapters',
  'moments',
])
const PRODUCER_FIELDS = new Set([
  'provider',
  'model',
  'version',
  'confidence',
])
const OBSERVATION_FIELDS = new Set(['value', 'confidence'])
const CHAPTER_FIELDS = new Set([
  'sourceChapterId',
  'title',
  'topicPath',
  'rangeMs',
])
const MOMENT_FIELDS = new Set([
  'sourceMomentId',
  'sourceChapterId',
  'topic',
  'summary',
  'keyQuote',
  'speakerIds',
  'rangesMs',
  'recommendedRangeIndex',
  'evidenceSpanIds',
  'salience',
  'hookPotential',
  'standaloneScore',
  'contextScore',
  'insightDensity',
  'roles',
  'tags',
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
): LongFormObservationInput {
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

function producer(value: unknown): LongFormProducer {
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

function range(
  value: unknown,
  field: string,
): readonly [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(Number.isSafeInteger)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain two integers`,
    )
  }
  return value as [number, number]
}

function chapter(value: unknown, index: number): LongFormChapterInput {
  const field = `chapters[${index}]`
  const input = record(value, field)
  exactFields(input, CHAPTER_FIELDS, field)
  if (typeof input.sourceChapterId !== 'string') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.sourceChapterId is invalid`,
    )
  }
  return {
    sourceChapterId: input.sourceChapterId,
    title: observation(input.title, `${field}.title`),
    topicPath: strings(input.topicPath, `${field}.topicPath`),
    rangeMs: range(input.rangeMs, `${field}.rangeMs`),
  }
}

function moment(value: unknown, index: number): LongFormMomentInput {
  const field = `moments[${index}]`
  const input = record(value, field)
  exactFields(input, MOMENT_FIELDS, field)
  if (
    typeof input.sourceMomentId !== 'string' ||
    typeof input.sourceChapterId !== 'string' ||
    !Array.isArray(input.rangesMs) ||
    typeof input.recommendedRangeIndex !== 'number' ||
    typeof input.salience !== 'number' ||
    typeof input.hookPotential !== 'number' ||
    typeof input.standaloneScore !== 'number' ||
    typeof input.contextScore !== 'number' ||
    typeof input.insightDensity !== 'number'
  ) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return {
    sourceMomentId: input.sourceMomentId,
    sourceChapterId: input.sourceChapterId,
    topic: observation(input.topic, `${field}.topic`),
    summary: observation(input.summary, `${field}.summary`),
    ...(input.keyQuote !== undefined
      ? { keyQuote: observation(input.keyQuote, `${field}.keyQuote`) }
      : {}),
    speakerIds: strings(input.speakerIds, `${field}.speakerIds`),
    rangesMs: input.rangesMs.map((item, rangeIndex) =>
      range(item, `${field}.rangesMs[${rangeIndex}]`)),
    recommendedRangeIndex: input.recommendedRangeIndex,
    evidenceSpanIds: strings(
      input.evidenceSpanIds,
      `${field}.evidenceSpanIds`,
    ),
    salience: input.salience,
    hookPotential: input.hookPotential,
    standaloneScore: input.standaloneScore,
    contextScore: input.contextScore,
    insightDensity: input.insightDensity,
    roles: strings(input.roles, `${field}.roles`),
    tags: strings(input.tags, `${field}.tags`),
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
    body.indexPolicyVersion !== LONG_FORM_INDEX_POLICY_VERSION ||
    !Array.isArray(body.chapters) ||
    !Array.isArray(body.moments)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Long-form index request is invalid',
    )
  }
  return {
    sourceArtifactId: body.sourceArtifactId,
    expectedArtifactSha256: body.expectedArtifactSha256,
    sourceManifestId: body.sourceManifestId,
    expectedManifestHash: body.expectedManifestHash,
    indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
    producer: producer(body.producer),
    chapters: body.chapters.map(chapter),
    moments: body.moments.map(moment),
  }
}

function presentRun(
  run: Awaited<
    ReturnType<ReturnType<typeof catalogLongFormMomentsService>>
  >['run'],
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    authenticationAudit: _authenticationAudit,
    provenance: _provenance,
    ...publicRun
  } = run
  return publicRun
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
    const result = await catalogLongFormMomentsService({
      repository: createLongFormIndexRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      provenance: Object.freeze({ kind: 'external-request' as const }),
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
  'chapterId',
  'sourceArtifactId',
  'speakerId',
  'role',
  'tag',
  'minSalience',
  'contextBeforeMs',
  'contextAfterMs',
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
          `${name} is not a supported long-form search parameter`,
        )
      }
    }
    const { projectId } = await context.params
    const results = await searchLongFormMomentsService({
      repository: createLongFormIndexRepository(),
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(params.has('q') ? { text: params.get('q') ?? undefined } : {}),
      ...(params.has('chapterId')
        ? { chapterId: params.get('chapterId') ?? undefined }
        : {}),
      ...(params.has('sourceArtifactId')
        ? {
            sourceArtifactId:
              params.get('sourceArtifactId') ?? undefined,
          }
        : {}),
      ...(params.has('speakerId')
        ? { speakerId: params.get('speakerId') ?? undefined }
        : {}),
      ...(params.has('role')
        ? { role: params.get('role') ?? undefined }
        : {}),
      ...(params.has('tag')
        ? { tag: params.get('tag') ?? undefined }
        : {}),
      ...(params.has('minSalience')
        ? { minSalience: Number(params.get('minSalience')) }
        : {}),
      ...(params.has('contextBeforeMs')
        ? { contextBeforeMs: Number(params.get('contextBeforeMs')) }
        : {}),
      ...(params.has('contextAfterMs')
        ? { contextAfterMs: Number(params.get('contextAfterMs')) }
        : {}),
      ...(params.has('limit')
        ? { limit: Number(params.get('limit')) }
        : {}),
    })
    return NextResponse.json(
      presentSuccess({
        results: results.map((result) => ({
          moment: result.moment,
          chapter: result.chapter,
          matchedBy: result.matchedBy,
          preview: result.preview,
          rightsSnapshotId: result.rightsSnapshotId,
          rightsStatus: result.rightsStatus,
          consentStatus: result.consentStatus,
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
