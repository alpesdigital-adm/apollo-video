import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  SCRIPT_BLOCK_ROLES,
  createScriptAlignmentRun,
  importScriptDocument,
  reviewScriptAlignmentRun,
  type ScriptAlignmentReviewDecision,
  type ScriptBlockRole,
} from '../domain/script-alignment.ts'
import type {
  ScriptAlignmentRepository,
} from './ports/script-alignment-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function actorClientId(
  actor: Readonly<{ type: 'api-client'; id: string }>,
): string {
  assertDomain(
    actor?.type === 'api-client',
    'AUTH_INVALID',
    'Script alignment requires an API client actor',
  )
  return identity(actor.id, 'actor.id')
}

function now(clock: () => Date): string {
  const value = clock()
  assertDomain(
    value instanceof Date && Number.isFinite(value.getTime()),
    'INVALID_ARGUMENT',
    'Clock returned an invalid instant',
  )
  return value.toISOString()
}

function assertReplay(
  replay: Readonly<{ requestFingerprint: string }>,
  expected: string,
) {
  if (replay.requestFingerprint !== expected) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was used with a different script alignment request',
    )
  }
}

function sourceRequests(
  value: readonly Readonly<{
    transcriptId: string
    expectedTranscriptHash: string
    roleHint?: ScriptBlockRole
  }>[],
) {
  assertDomain(
    Array.isArray(value) && value.length >= 1 && value.length <= 50,
    'INVALID_ARGUMENT',
    'sources must contain 1 to 50 transcript references',
  )
  const seen = new Set<string>()
  return Object.freeze(value.map((source) => {
    const transcriptId = identity(source?.transcriptId, 'transcriptId')
    assertDomain(
      HASH.test(source?.expectedTranscriptHash ?? '') &&
      !seen.has(transcriptId) &&
      (
        source.roleHint === undefined ||
        SCRIPT_BLOCK_ROLES.includes(source.roleHint)
      ),
      'INVALID_ARGUMENT',
      `Transcript source ${transcriptId} is invalid`,
    )
    seen.add(transcriptId)
    return Object.freeze({
      transcriptId,
      expectedTranscriptHash: source.expectedTranscriptHash,
      ...(source.roleHint ? { roleHint: source.roleHint } : {}),
    })
  }))
}

export interface CreateScriptAlignmentRequest {
  workspaceId: string
  batchId: string
  title: string
  locale: string
  rawText: string
  sources: readonly Readonly<{
    transcriptId: string
    expectedTranscriptHash: string
    roleHint?: ScriptBlockRole
  }>[]
  actor: Readonly<{ type: 'api-client'; id: string }>
  idempotencyKey: string
}

export function createScriptAlignmentService(dependencies: {
  repository: ScriptAlignmentRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(
    request: Readonly<CreateScriptAlignmentRequest>,
  ) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const clientId = actorClientId(request.actor)
    const key = idempotencyKey(request.idempotencyKey)
    const document = importScriptDocument({
      title: request.title,
      locale: request.locale,
      rawText: request.rawText,
    })
    const sources = sourceRequests(request.sources)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'script-alignment-create-request/v1',
      workspaceId,
      batchId,
      documentHash: document.documentHash,
      sources,
      actorClientId: clientId,
    })
    const replay = await dependencies.repository.findCreateReplay({
      workspaceId,
      actorClientId: clientId,
      idempotencyKey: key,
    })
    if (replay) {
      assertReplay(replay, requestFingerprint)
      return Object.freeze({ run: replay.run, replayed: true })
    }
    const context = await dependencies.repository.loadCreationContext({
      workspaceId,
      batchId,
      actorClientId: clientId,
      sources,
    })
    const run = createScriptAlignmentRun({
      id: identity(dependencies.createRunId(), 'created alignment ID'),
      workspaceId,
      projectId: identity(context.projectId, 'projectId'),
      batchId,
      document,
      sources: context.sources,
      createdByClientId: clientId,
      createdAt: now(dependencies.clock),
    })
    return dependencies.repository.create({
      run,
      requestFingerprint,
      idempotencyKey: key,
    })
  }
}

export function readScriptAlignmentService(dependencies: {
  repository: ScriptAlignmentRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    runId: string
  }) {
    const run = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      runId: identity(request.runId, 'alignmentId'),
    })
    if (!run) {
      throw new DomainError(
        'SCRIPT_ALIGNMENT_NOT_FOUND',
        'Script alignment was not found',
      )
    }
    return run
  }
}

export function listScriptAlignmentsService(dependencies: {
  repository: ScriptAlignmentRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

export function reviewScriptAlignmentService(dependencies: {
  repository: ScriptAlignmentRepository
  clock: () => Date
  createReviewId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    runId: string
    expectedRevision: number
    decisions: readonly ScriptAlignmentReviewDecision[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const runId = identity(request.runId, 'alignmentId')
    const clientId = actorClientId(request.actor)
    const key = idempotencyKey(request.idempotencyKey)
    assertDomain(
      Number.isSafeInteger(request.expectedRevision) &&
      request.expectedRevision >= 1 &&
      request.expectedRevision <= 1_000_000 &&
      Array.isArray(request.decisions),
      'INVALID_ARGUMENT',
      'Script alignment review revision or decisions are invalid',
    )
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'script-alignment-review-request/v1',
      workspaceId,
      batchId,
      runId,
      expectedRevision: request.expectedRevision,
      decisions: request.decisions,
      actorClientId: clientId,
    })
    const replay = await dependencies.repository.findReviewReplay({
      workspaceId,
      actorClientId: clientId,
      idempotencyKey: key,
    })
    if (replay) {
      assertReplay(replay, requestFingerprint)
      return Object.freeze({ run: replay.run, replayed: true })
    }
    const current = await dependencies.repository.read({
      workspaceId,
      batchId,
      runId,
    })
    if (!current) {
      throw new DomainError(
        'SCRIPT_ALIGNMENT_NOT_FOUND',
        'Script alignment was not found',
      )
    }
    const resultingRun = reviewScriptAlignmentRun({
      run: current,
      expectedRevision: request.expectedRevision,
      reviewId: identity(
        dependencies.createReviewId(),
        'created review ID',
      ),
      actorClientId: clientId,
      decisions: request.decisions,
      createdAt: now(dependencies.clock),
    })
    return dependencies.repository.persistReview({
      previousRun: current,
      resultingRun,
      review: resultingRun.reviews.at(-1)!,
      requestFingerprint,
      idempotencyKey: key,
    })
  }
}
