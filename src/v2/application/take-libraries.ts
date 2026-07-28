import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  TAKE_DIMENSIONS,
  createTakeLibraryRun,
  selectTakeManually,
  type TakeIntentionRole,
  type TakeMeasuredDimensionInput,
  type TakeSourceEvaluationInput,
  type TakeSourceKind,
} from '../domain/take-library.ts'
import type {
  TakeLibraryRepository,
} from './ports/take-library-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
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
    'Take library requires an API client actor',
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

function isArray(value: unknown): boolean {
  return Array.isArray(value)
}

function replay(
  value: Readonly<{ requestFingerprint: string }>,
  expected: string,
) {
  if (value.requestFingerprint !== expected) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was used with a different take library request',
    )
  }
}

function evaluations(
  values: readonly TakeSourceEvaluationInput[],
): readonly TakeSourceEvaluationInput[] {
  assertDomain(
    isArray(values) && values.length <= 2_000,
    'INVALID_ARGUMENT',
    'evaluations must contain at most 2000 entries',
  )
  return Object.freeze(values.map((value, index) => {
    assertDomain(
      value?.sourceKind === 'alignment-candidate' ||
      value?.sourceKind === 'extra-take',
      'INVALID_ARGUMENT',
      `evaluations[${index}].sourceKind is invalid`,
    )
    assertDomain(
      HASH.test(value.expectedSourceHash ?? '') &&
      isArray(value.dimensions) &&
      value.dimensions.length <= TAKE_DIMENSIONS.length,
      'INVALID_ARGUMENT',
      `evaluations[${index}] is invalid`,
    )
    return Object.freeze({
      sourceKind: value.sourceKind as TakeSourceKind,
      sourceId: identity(
        value.sourceId,
        `evaluations[${index}].sourceId`,
      ),
      expectedSourceHash: value.expectedSourceHash,
      dimensions: Object.freeze(value.dimensions.map((
        dimension,
      ): TakeMeasuredDimensionInput => Object.freeze({
        dimension: dimension.dimension,
        score: dimension.score,
        evaluatorVersion: dimension.evaluatorVersion,
        evidenceRefs: Object.freeze([...dimension.evidenceRefs]),
        ...(dimension.reasonCodes
          ? { reasonCodes: Object.freeze([...dimension.reasonCodes]) }
          : {}),
      }))),
      ...(value.inferredIntention
        ? {
            inferredIntention: Object.freeze({
              role: value.inferredIntention.role as TakeIntentionRole,
              label: value.inferredIntention.label,
              confidence: value.inferredIntention.confidence,
              evidenceRefs: Object.freeze([
                ...value.inferredIntention.evidenceRefs,
              ]),
            }),
          }
        : {}),
    })
  }))
}

export interface CreateTakeLibraryRequest {
  workspaceId: string
  batchId: string
  alignmentId: string
  expectedAlignmentRunHash: string
  evaluations: readonly TakeSourceEvaluationInput[]
  actor: Readonly<{ type: 'api-client'; id: string }>
  idempotencyKey: string
}

export function createTakeLibraryService(dependencies: {
  repository: TakeLibraryRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(
    request: Readonly<CreateTakeLibraryRequest>,
  ) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const alignmentId = identity(request.alignmentId, 'alignmentId')
    assertDomain(
      HASH.test(request.expectedAlignmentRunHash ?? ''),
      'INVALID_ARGUMENT',
      'expectedAlignmentRunHash is invalid',
    )
    const clientId = actorClientId(request.actor)
    const key = idempotencyKey(request.idempotencyKey)
    const supplied = evaluations(request.evaluations)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'take-library-create-request/v1',
      workspaceId,
      batchId,
      alignmentId,
      expectedAlignmentRunHash: request.expectedAlignmentRunHash,
      evaluations: supplied,
      actorClientId: clientId,
    })
    const existing = await dependencies.repository.findCreateReplay({
      workspaceId,
      actorClientId: clientId,
      idempotencyKey: key,
    })
    if (existing) {
      replay(existing, requestFingerprint)
      return Object.freeze({ run: existing.run, replayed: true })
    }
    const context = await dependencies.repository.loadCreationContext({
      workspaceId,
      batchId,
      alignmentId,
      expectedAlignmentRunHash: request.expectedAlignmentRunHash,
      actorClientId: clientId,
    })
    const run = createTakeLibraryRun({
      id: identity(dependencies.createRunId(), 'created take library ID'),
      workspaceId,
      projectId: identity(context.projectId, 'projectId'),
      batchId,
      alignment: context.alignment,
      evaluations: supplied,
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

export function readTakeLibraryService(dependencies: {
  repository: TakeLibraryRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    runId: string
  }) {
    const run = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      runId: identity(request.runId, 'takeLibraryId'),
    })
    if (!run) {
      throw new DomainError(
        'TAKE_LIBRARY_NOT_FOUND',
        'Take library was not found',
      )
    }
    return run
  }
}

export function listTakeLibrariesService(dependencies: {
  repository: TakeLibraryRepository
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

export function selectTakeService(dependencies: {
  repository: TakeLibraryRepository
  clock: () => Date
  createSelectionId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    runId: string
    expectedRevision: number
    groupId: string
    takeId: string
    protect: boolean
    replacedProtectedTakeId?: string
    note?: string
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const runId = identity(request.runId, 'takeLibraryId')
    const groupId = identity(request.groupId, 'groupId')
    const takeId = identity(request.takeId, 'takeId')
    const clientId = actorClientId(request.actor)
    const key = idempotencyKey(request.idempotencyKey)
    assertDomain(
      Number.isSafeInteger(request.expectedRevision) &&
      request.expectedRevision >= 1 &&
      request.expectedRevision <= 1_000_000 &&
      typeof request.protect === 'boolean',
      'INVALID_ARGUMENT',
      'Take selection revision or protection is invalid',
    )
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'take-library-selection-request/v1',
      workspaceId,
      batchId,
      runId,
      expectedRevision: request.expectedRevision,
      groupId,
      takeId,
      protect: request.protect,
      ...(request.replacedProtectedTakeId
        ? {
            replacedProtectedTakeId: identity(
              request.replacedProtectedTakeId,
              'replacedProtectedTakeId',
            ),
          }
        : {}),
      ...(request.note ? { note: request.note } : {}),
      actorClientId: clientId,
    })
    const existing = await dependencies.repository.findSelectionReplay({
      workspaceId,
      actorClientId: clientId,
      idempotencyKey: key,
    })
    if (existing) {
      replay(existing, requestFingerprint)
      return Object.freeze({ run: existing.run, replayed: true })
    }
    const current = await dependencies.repository.read({
      workspaceId,
      batchId,
      runId,
    })
    if (!current) {
      throw new DomainError(
        'TAKE_LIBRARY_NOT_FOUND',
        'Take library was not found',
      )
    }
    const result = selectTakeManually({
      run: current,
      selectionId: identity(
        dependencies.createSelectionId(),
        'created selection ID',
      ),
      expectedRevision: request.expectedRevision,
      groupId,
      takeId,
      protect: request.protect,
      ...(request.replacedProtectedTakeId
        ? { replacedProtectedTakeId: request.replacedProtectedTakeId }
        : {}),
      ...(request.note ? { note: request.note } : {}),
      actorClientId: clientId,
      createdAt: now(dependencies.clock),
    })
    return dependencies.repository.persistSelection({
      previousRun: current,
      resultingRun: result.run,
      selection: result.selection,
      requestFingerprint,
      idempotencyKey: key,
    })
  }
}
