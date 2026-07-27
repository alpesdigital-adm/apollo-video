import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  batchProgress,
  cancelProductionBatch,
  createProductionBatch,
  deriveBatchStatus,
  hydrateProductionBatch,
  resumeProductionBatch,
  transitionBatchItem,
  type BatchItemAction,
  type BatchItemError,
  type ProductionBatch,
  type ProductionBatchRecipe,
  type ProductionBatchSourceGroup,
  type ProductionBatchStatus,
  type ProductionBatchStep,
  type ProductionBatchVariant,
} from '../domain/production-batch.ts'
import type {
  ProductionBatchRepository,
} from './ports/production-batch-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/
const BATCH_STATUSES = new Set<ProductionBatchStatus>([
  'queued',
  'running',
  'review',
  'partially-completed',
  'completed',
  'failed',
  'cancelled',
])

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

function expectedRevision(value: unknown, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= 1 &&
      Number(value) <= 1_000_000,
    'INVALID_ARGUMENT',
    `${field} must be an integer between 1 and 1,000,000`,
  )
  return Number(value)
}

function instant(clock: () => Date): string {
  const now = clock()
  assertDomain(
    now instanceof Date && Number.isFinite(now.getTime()),
    'INVALID_ARGUMENT',
    'Clock returned an invalid instant',
  )
  return now.toISOString()
}

function assertReplayFingerprint(
  replay: Readonly<{ requestFingerprint: string }>,
  requestFingerprint: string,
): void {
  if (replay.requestFingerprint !== requestFingerprint) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was used with a different production batch request',
    )
  }
}

export interface CreateProductionBatchRequest {
  workspaceId: string
  projectId: string
  name: string
  objective: string
  sourceGroups: readonly Readonly<ProductionBatchSourceGroup>[]
  recipes: readonly Readonly<ProductionBatchRecipe>[]
  variants: readonly Readonly<ProductionBatchVariant>[]
  budget: Readonly<{
    currency: 'USD'
    maxCostMinorUnits: number
    reservedCostMinorUnits: number
  }>
  items: readonly Readonly<{
    key: string
    sourceGroupId: string
    recipeId: string
    variantId: string
  }>[]
  actor: Readonly<{ type: 'api-client'; id: string }>
  idempotencyKey: string
}

export function createProductionBatchService(dependencies: {
  repository: ProductionBatchRepository
  clock: () => Date
  createBatchId: () => string
  createItemId: () => string
}) {
  return async function execute(
    request: Readonly<CreateProductionBatchRequest>,
  ) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const actorClientId = identity(request.actor?.id, 'actor.id')
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'Production batch requires an API client actor',
    )
    const replayKey = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'production-batch-create-request/v1',
      workspaceId,
      projectId,
      name: request.name,
      objective: request.objective,
      sourceGroups: request.sourceGroups,
      recipes: request.recipes,
      variants: request.variants,
      budget: request.budget,
      items: request.items,
      actorClientId,
    })
    const replay = await dependencies.repository.findCreateReplay({
      workspaceId,
      actorClientId,
      idempotencyKey: replayKey,
    })
    if (replay) {
      assertReplayFingerprint(replay, requestFingerprint)
      return Object.freeze({
        batch: replay.batch,
        replayed: true,
      })
    }
    const createdAt = instant(dependencies.clock)
    const batch = createProductionBatch({
      id: identity(dependencies.createBatchId(), 'created batch ID'),
      workspaceId,
      projectId,
      name: request.name,
      objective: request.objective,
      sourceGroups: request.sourceGroups,
      recipes: request.recipes,
      variants: request.variants,
      budget: request.budget,
      itemDefinitions: request.items.map((item) => ({
        ...item,
        id: identity(dependencies.createItemId(), 'created item ID'),
      })),
      createdBy: request.actor,
      createdAt,
    })
    return dependencies.repository.create({
      batch,
      requestFingerprint,
      idempotencyKey: replayKey,
    })
  }
}

export function readProductionBatchService(dependencies: {
  repository: ProductionBatchRepository
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
  }) {
    const batch = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      batchId: identity(request.batchId, 'batchId'),
    })
    if (!batch) {
      throw new DomainError(
        'PRODUCTION_BATCH_NOT_FOUND',
        'Production batch was not found',
      )
    }
    return batch
  }
}

export function listProductionBatchesService(dependencies: {
  repository: ProductionBatchRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId?: string
    status?: string
    query?: string
    limit?: number
    cursor?: string
  }) {
    const status = request.status?.trim() || undefined
    assertDomain(
      status === undefined ||
        BATCH_STATUSES.has(status as ProductionBatchStatus),
      'INVALID_ARGUMENT',
      'status is invalid',
    )
    const query = request.query?.trim().replace(/\s+/g, ' ') || undefined
    assertDomain(
      query === undefined || query.length <= 200,
      'INVALID_ARGUMENT',
      'query must not exceed 200 characters',
    )
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      ...(request.projectId
        ? { projectId: identity(request.projectId, 'projectId') }
        : {}),
      ...(status ? { status: status as ProductionBatchStatus } : {}),
      ...(query ? { query } : {}),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

function actionFingerprint(input: {
  workspaceId: string
  batchId: string
  itemId?: string
  action: string
  step?: ProductionBatchStep
  expectedBatchRevision: number
  expectedItemRevision?: number
  costMinorUnits?: number
  cacheHit?: boolean
  error?: Readonly<BatchItemError>
  artifactIds?: readonly string[]
  actorClientId: string
}): string {
  return calculateCanonicalHash({
    schemaVersion: 'production-batch-action-request/v1',
    ...input,
  })
}

function changedBatch(
  current: Readonly<ProductionBatch>,
  item: Readonly<ProductionBatch['items'][number]>,
  now: string,
): Readonly<ProductionBatch> {
  return hydrateProductionBatch(Object.freeze({
    ...current,
    revision: current.revision + 1,
    items: Object.freeze(current.items.map((candidate) =>
      candidate.id === item.id ? item : candidate)),
    updatedAt: now,
  }))
}

export function actOnProductionBatchItemService(dependencies: {
  repository: ProductionBatchRepository
  clock: () => Date
  createActionId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    itemId: string
    action: BatchItemAction
    step?: ProductionBatchStep
    expectedBatchRevision: number
    expectedItemRevision: number
    costMinorUnits?: number
    cacheHit?: boolean
    error?: Readonly<BatchItemError>
    artifactIds?: readonly string[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const itemId = identity(request.itemId, 'itemId')
    const actorClientId = identity(request.actor?.id, 'actor.id')
    const batchRevision = expectedRevision(
      request.expectedBatchRevision,
      'expectedBatchRevision',
    )
    const itemRevision = expectedRevision(
      request.expectedItemRevision,
      'expectedItemRevision',
    )
    const replayKey = idempotencyKey(request.idempotencyKey)
    const fingerprint = actionFingerprint({
      workspaceId,
      batchId,
      itemId,
      action: request.action,
      ...(request.step ? { step: request.step } : {}),
      expectedBatchRevision: batchRevision,
      expectedItemRevision: itemRevision,
      ...(request.costMinorUnits !== undefined
        ? { costMinorUnits: request.costMinorUnits }
        : {}),
      ...(request.cacheHit !== undefined
        ? { cacheHit: request.cacheHit }
        : {}),
      ...(request.error ? { error: request.error } : {}),
      ...(request.artifactIds
        ? { artifactIds: request.artifactIds }
        : {}),
      actorClientId,
    })
    const replay = await dependencies.repository.findActionReplay({
      workspaceId,
      actorClientId,
      idempotencyKey: replayKey,
    })
    if (replay) {
      assertReplayFingerprint(replay, fingerprint)
      return Object.freeze({ batch: replay.batch, replayed: true })
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
    assertDomain(
      batch.revision === batchRevision,
      'VERSION_CONFLICT',
      'Production batch revision is stale',
    )
    const item = batch.items.find((candidate) => candidate.id === itemId)
    if (!item) {
      throw new DomainError(
        'PRODUCTION_BATCH_ITEM_NOT_FOUND',
        'Production batch item was not found',
      )
    }
    assertDomain(
      item.revision === itemRevision,
      'VERSION_CONFLICT',
      'Production batch item revision is stale',
    )
    const stepAction = [
      'start-step',
      'complete-step',
      'fail-step',
      'retry-step',
    ].includes(request.action)
    assertDomain(
      stepAction === Boolean(request.step) &&
        (request.action === 'fail-step') === Boolean(request.error) &&
        (
          request.artifactIds === undefined ||
          request.action === 'complete-step'
        ) &&
        (
          request.costMinorUnits === undefined ||
          ['complete-step', 'fail-step'].includes(request.action)
        ) &&
        (
          request.cacheHit === undefined ||
          ['complete-step', 'fail-step'].includes(request.action)
        ),
      'INVALID_ARGUMENT',
      'Production batch item action fields are inconsistent',
    )
    const now = instant(dependencies.clock)
    const changedItem = transitionBatchItem({
      item,
      action: request.action,
      now,
      ...(request.step ? { step: request.step } : {}),
      ...(request.costMinorUnits !== undefined
        ? { costMinorUnits: request.costMinorUnits }
        : {}),
      ...(request.cacheHit !== undefined
        ? { cacheHit: request.cacheHit }
        : {}),
      ...(request.error ? { error: request.error } : {}),
      ...(request.artifactIds
        ? { artifactIds: request.artifactIds }
        : {}),
    })
    const next = changedBatch(batch, changedItem, now)
    assertDomain(
      batchProgress(next).spentMinorUnits <=
        next.budget.maxCostMinorUnits,
      'PRECONDITION_REQUIRED',
      'Production batch budget would be exceeded',
    )
    return dependencies.repository.persistAction({
      id: identity(dependencies.createActionId(), 'created action ID'),
      workspaceId,
      batchId,
      itemId,
      scope: 'item',
      action: request.action,
      ...(request.step ? { step: request.step } : {}),
      expectedBatchRevision: batchRevision,
      expectedItemRevision: itemRevision,
      requestFingerprint: fingerprint,
      idempotencyKey: replayKey,
      actorClientId,
      createdAt: now,
      resultingBatch: next,
    })
  }
}

export function actOnProductionBatchService(dependencies: {
  repository: ProductionBatchRepository
  clock: () => Date
  createActionId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    batchId: string
    action: 'cancel' | 'resume'
    expectedBatchRevision: number
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const batchId = identity(request.batchId, 'batchId')
    const actorClientId = identity(request.actor?.id, 'actor.id')
    const batchRevision = expectedRevision(
      request.expectedBatchRevision,
      'expectedBatchRevision',
    )
    const replayKey = idempotencyKey(request.idempotencyKey)
    const fingerprint = actionFingerprint({
      workspaceId,
      batchId,
      action: request.action,
      expectedBatchRevision: batchRevision,
      actorClientId,
    })
    const replay = await dependencies.repository.findActionReplay({
      workspaceId,
      actorClientId,
      idempotencyKey: replayKey,
    })
    if (replay) {
      assertReplayFingerprint(replay, fingerprint)
      return Object.freeze({ batch: replay.batch, replayed: true })
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
    assertDomain(
      batch.revision === batchRevision,
      'VERSION_CONFLICT',
      'Production batch revision is stale',
    )
    const now = instant(dependencies.clock)
    const next = request.action === 'cancel'
      ? cancelProductionBatch({ batch, now })
      : resumeProductionBatch({ batch, now })
    assertDomain(
      deriveBatchStatus(next) !== deriveBatchStatus(batch) ||
        next.items.some((item, index) =>
          item.revision !== batch.items[index]?.revision),
      'VERSION_CONFLICT',
      'Production batch action made no state change',
    )
    return dependencies.repository.persistAction({
      id: identity(dependencies.createActionId(), 'created action ID'),
      workspaceId,
      batchId,
      scope: 'batch',
      action: request.action,
      expectedBatchRevision: batchRevision,
      requestFingerprint: fingerprint,
      idempotencyKey: replayKey,
      actorClientId,
      createdAt: now,
      resultingBatch: next,
    })
  }
}
