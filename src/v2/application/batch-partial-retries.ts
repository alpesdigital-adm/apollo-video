import type {
  ProductionBatchRepository,
} from './ports/production-batch-repository.ts'
import {
  createBatchPartialRetry,
  type BatchPartialRetryTarget,
} from '../domain/batch-partial-retry.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/
const HASH = /^[a-f0-9]{64}$/

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
    typeof value === 'string' && IDEMPOTENCY_KEY.test(value),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value
}

function expectedRevision(value: unknown, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= 1 &&
      Number(value) <= 1_000_000,
    'INVALID_ARGUMENT',
    `${field} must be an integer between 1 and 1000000`,
  )
  return Number(value)
}

function normalizedTargets(
  value: readonly Readonly<BatchPartialRetryTarget>[],
): readonly Readonly<BatchPartialRetryTarget>[] {
  assertDomain(
    Array.isArray(value) && value.length >= 1 && value.length <= 100,
    'INVALID_ARGUMENT',
    'targets must contain one to 100 failed item steps',
  )
  const result = value.map((target, index) => {
    assertDomain(
      target.step === 'planning' ||
        target.step === 'materializing' ||
        target.step === 'rendering' ||
        target.step === 'reviewing',
      'INVALID_ARGUMENT',
      `targets[${index}].step is invalid`,
    )
    assertDomain(
      typeof target.expectedStepHash === 'string' &&
        HASH.test(target.expectedStepHash),
      'INVALID_ARGUMENT',
      `targets[${index}].expectedStepHash is invalid`,
    )
    return Object.freeze({
      itemId: identity(target.itemId, `targets[${index}].itemId`),
      step: target.step,
      expectedItemRevision: expectedRevision(
        target.expectedItemRevision,
        `targets[${index}].expectedItemRevision`,
      ),
      expectedStepHash: target.expectedStepHash,
    })
  })
  assertDomain(
    new Set(result.map((target) => target.itemId)).size ===
      result.length,
    'INVALID_ARGUMENT',
    'targets must contain at most one failed step per item',
  )
  return Object.freeze(result)
}

function requestFingerprint(input: {
  workspaceId: string
  batchId: string
  expectedBatchRevision: number
  targets: readonly Readonly<BatchPartialRetryTarget>[]
  actorClientId: string
}) {
  return calculateCanonicalHash({
    schemaVersion: 'batch-partial-retry-request/v1',
    ...input,
  })
}

function assertReplayFingerprint(
  actual: string,
  expected: string,
) {
  if (actual !== expected) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was used with a different batch partial retry request',
    )
  }
}

export function createBatchPartialRetryService(dependencies: {
  repository: ProductionBatchRepository
  clock: () => Date
  createRetryId: () => string
  createJobId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    expectedBatchRevision: number
    targets: readonly Readonly<BatchPartialRetryTarget>[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const actorClientId = identity(request.actor?.id, 'actor.id')
    const expectedBatchRevision = expectedRevision(
      request.expectedBatchRevision,
      'expectedBatchRevision',
    )
    const targets = normalizedTargets(request.targets)
    const replayKey = idempotencyKey(request.idempotencyKey)
    const fingerprint = requestFingerprint({
      workspaceId,
      batchId,
      expectedBatchRevision,
      targets,
      actorClientId,
    })
    const replay = await dependencies.repository.findPartialRetryReplay({
      workspaceId,
      actorClientId,
      idempotencyKey: replayKey,
    })
    if (replay) {
      assertReplayFingerprint(replay.requestFingerprint, fingerprint)
      return Object.freeze({
        batch: replay.batch,
        partialRetry: replay.partialRetry,
        replayed: true,
      })
    }
    const batch = await dependencies.repository.read({
      workspaceId,
      batchId,
    })
    if (!batch) {
      throw new DomainError(
        'PRODUCTION_BATCH_NOT_FOUND',
        'Production batch was not found',
      )
    }
    const createdAt = dependencies.clock().toISOString()
    const retryId = identity(
      dependencies.createRetryId(),
      'created retry ID',
    )
    const compiled = createBatchPartialRetry({
      id: retryId,
      batch,
      expectedBatchRevision,
      targets,
      actorClientId,
      createdAt,
      createJobId: () =>
        identity(dependencies.createJobId(), 'created retry job ID'),
    })
    const persisted = await dependencies.repository.persistAction({
      id: retryId,
      workspaceId,
      batchId,
      scope: 'batch',
      action: 'partial-retry',
      expectedBatchRevision,
      requestFingerprint: fingerprint,
      idempotencyKey: replayKey,
      actorClientId,
      createdAt,
      resultingBatch: compiled.batch,
      partialRetry: compiled.retry,
    })
    assertDomain(
      Boolean(persisted.partialRetry),
      'PERSISTENCE_CONFLICT',
      'Persisted partial retry response is missing its manifest',
    )
    return Object.freeze({
      batch: persisted.batch,
      partialRetry: persisted.partialRetry!,
      replayed: persisted.replayed,
    })
  }
}

export function readBatchPartialRetryService(dependencies: {
  repository: ProductionBatchRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    retryId: string
  }) {
    const partialRetry = await dependencies.repository.readPartialRetry({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      retryId: identity(request.retryId, 'retryId'),
    })
    if (!partialRetry) {
      throw new DomainError(
        'PRODUCTION_BATCH_PARTIAL_RETRY_NOT_FOUND',
        'Production batch partial retry was not found',
      )
    }
    return partialRetry
  }
}

export function listBatchPartialRetriesService(dependencies: {
  repository: ProductionBatchRepository
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
    return dependencies.repository.listPartialRetries({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}
