import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  batchProgress,
  hydrateProductionBatch,
  transitionBatchItem,
  type ProductionBatch,
  type ProductionBatchProgress,
  type ProductionBatchStep,
} from './production-batch.ts'

export const BATCH_PARTIAL_RETRY_SCHEMA_VERSION =
  'batch-partial-retry/v1' as const
export const BATCH_PARTIAL_RETRY_JOB_SCHEMA_VERSION =
  'batch-partial-retry-job/v1' as const
export const BATCH_PARTIAL_RETRY_LINEAGE_VERSION =
  'batch-partial-retry-lineage/v1' as const

export type BatchRetryExecutorClass =
  | 'director'
  | 'provider'
  | 'renderer'
  | 'validator'

export interface BatchPartialRetryTarget {
  itemId: string
  step: ProductionBatchStep
  expectedItemRevision: number
  expectedStepHash: string
}

export interface BatchPartialRetryJob {
  schemaVersion: typeof BATCH_PARTIAL_RETRY_JOB_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  retryId: string
  itemId: string
  step: ProductionBatchStep
  executorClass: BatchRetryExecutorClass
  status: 'queued'
  lineageKey: string
  failedAttempt: number
  retryAttempt: number
  previousStepHash: string
  queuedStepHash: string
  failureCode: string
  failureMessage: string
  preservedArtifactIds: readonly string[]
  preservedArtifactCount: number
  chargedMinorUnitsAtEnqueue: 0
  createdAt: string
  jobHash: string
}

export interface BatchPartialRetryRun {
  schemaVersion: typeof BATCH_PARTIAL_RETRY_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  batchDefinitionHash: string
  batchRevisionBefore: number
  batchRevisionAfter: number
  status: 'queued'
  jobs: readonly Readonly<BatchPartialRetryJob>[]
  targetCount: number
  preservedCompletedItemIds: readonly string[]
  preservedArtifactIds: readonly string[]
  progressBefore: Readonly<ProductionBatchProgress>
  progressAfter: Readonly<ProductionBatchProgress>
  spentMinorUnitsBefore: number
  spentMinorUnitsAfter: number
  remainingMinorUnitsBefore: number
  remainingMinorUnitsAfter: number
  createdByClientId: string
  createdAt: string
  retryHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be an ISO instant`,
  )
  return value
}

function revision(value: unknown, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= 1 &&
      Number(value) <= 1_000_000,
    'INVALID_ARGUMENT',
    `${field} must be an integer between 1 and 1000000`,
  )
  return Number(value)
}

function executorClass(
  step: ProductionBatchStep,
): BatchRetryExecutorClass {
  if (step === 'planning') return 'director'
  if (step === 'materializing') return 'provider'
  if (step === 'rendering') return 'renderer'
  return 'validator'
}

function progressBody(
  progress: Readonly<ProductionBatchProgress>,
): Readonly<ProductionBatchProgress> {
  return Object.freeze({ ...progress })
}

function jobBody(
  job: Omit<BatchPartialRetryJob, 'jobHash'>,
) {
  return job
}

function retryBody(
  retry: Omit<BatchPartialRetryRun, 'retryHash'>,
) {
  return retry
}

function freezeJob(
  value: Readonly<BatchPartialRetryJob>,
): Readonly<BatchPartialRetryJob> {
  const preservedArtifactIds = Object.freeze(
    value.preservedArtifactIds.map((artifactId, index) =>
      identity(artifactId, `preservedArtifactIds[${index}]`)),
  )
  assertDomain(
    new Set(preservedArtifactIds).size === preservedArtifactIds.length,
    'PERSISTENCE_CONFLICT',
    'Batch partial retry job contains duplicate preserved artifacts',
  )
  const content = Object.freeze({
    schemaVersion: BATCH_PARTIAL_RETRY_JOB_SCHEMA_VERSION,
    id: identity(value.id, 'job.id'),
    workspaceId: identity(value.workspaceId, 'job.workspaceId'),
    projectId: identity(value.projectId, 'job.projectId'),
    batchId: identity(value.batchId, 'job.batchId'),
    retryId: identity(value.retryId, 'job.retryId'),
    itemId: identity(value.itemId, 'job.itemId'),
    step: value.step,
    executorClass: value.executorClass,
    status: value.status,
    lineageKey: hash(value.lineageKey, 'job.lineageKey'),
    failedAttempt: Number(value.failedAttempt),
    retryAttempt: Number(value.retryAttempt),
    previousStepHash: hash(
      value.previousStepHash,
      'job.previousStepHash',
    ),
    queuedStepHash: hash(value.queuedStepHash, 'job.queuedStepHash'),
    failureCode: identity(value.failureCode, 'job.failureCode'),
    failureMessage: String(value.failureMessage),
    preservedArtifactIds,
    preservedArtifactCount: Number(value.preservedArtifactCount),
    chargedMinorUnitsAtEnqueue: 0 as const,
    createdAt: instant(value.createdAt, 'job.createdAt'),
  })
  assertDomain(
    ['planning', 'materializing', 'rendering', 'reviewing']
      .includes(content.step) &&
      executorClass(content.step) === content.executorClass &&
      content.status === 'queued' &&
      Number.isSafeInteger(content.failedAttempt) &&
      content.failedAttempt >= 1 &&
      content.failedAttempt <= 10_000 &&
      content.retryAttempt === content.failedAttempt + 1 &&
      content.failureMessage.length >= 1 &&
      content.failureMessage.length <= 500 &&
      content.preservedArtifactCount ===
        content.preservedArtifactIds.length,
    'PERSISTENCE_CONFLICT',
    'Batch partial retry job is inconsistent',
  )
  const jobHash = calculateCanonicalHash(jobBody(content))
  assertDomain(
    value.jobHash === jobHash,
    'PERSISTENCE_CONFLICT',
    'Batch partial retry job hash is invalid',
  )
  return Object.freeze({ ...content, jobHash })
}

export function hydrateBatchPartialRetry(
  value: Readonly<BatchPartialRetryRun>,
): Readonly<BatchPartialRetryRun> {
  const jobs = Object.freeze(value.jobs.map(freezeJob))
  const preservedCompletedItemIds = Object.freeze(
    value.preservedCompletedItemIds.map((itemId, index) =>
      identity(itemId, `preservedCompletedItemIds[${index}]`)),
  )
  const preservedArtifactIds = Object.freeze(
    value.preservedArtifactIds.map((artifactId, index) =>
      identity(artifactId, `preservedArtifactIds[${index}]`)),
  )
  const content = Object.freeze({
    schemaVersion: BATCH_PARTIAL_RETRY_SCHEMA_VERSION,
    id: identity(value.id, 'retry.id'),
    workspaceId: identity(value.workspaceId, 'retry.workspaceId'),
    projectId: identity(value.projectId, 'retry.projectId'),
    batchId: identity(value.batchId, 'retry.batchId'),
    batchDefinitionHash: hash(
      value.batchDefinitionHash,
      'retry.batchDefinitionHash',
    ),
    batchRevisionBefore: revision(
      value.batchRevisionBefore,
      'retry.batchRevisionBefore',
    ),
    batchRevisionAfter: revision(
      value.batchRevisionAfter,
      'retry.batchRevisionAfter',
    ),
    status: value.status,
    jobs,
    targetCount: Number(value.targetCount),
    preservedCompletedItemIds,
    preservedArtifactIds,
    progressBefore: progressBody(value.progressBefore),
    progressAfter: progressBody(value.progressAfter),
    spentMinorUnitsBefore: Number(value.spentMinorUnitsBefore),
    spentMinorUnitsAfter: Number(value.spentMinorUnitsAfter),
    remainingMinorUnitsBefore: Number(value.remainingMinorUnitsBefore),
    remainingMinorUnitsAfter: Number(value.remainingMinorUnitsAfter),
    createdByClientId: identity(
      value.createdByClientId,
      'retry.createdByClientId',
    ),
    createdAt: instant(value.createdAt, 'retry.createdAt'),
  })
  assertDomain(
    content.status === 'queued' &&
      content.batchRevisionAfter === content.batchRevisionBefore + 1 &&
      content.targetCount === content.jobs.length &&
      content.targetCount >= 1 &&
      content.targetCount <= 100 &&
      new Set(content.jobs.map((job) => job.itemId)).size ===
        content.jobs.length &&
      content.jobs.every((job) =>
        job.workspaceId === content.workspaceId &&
        job.projectId === content.projectId &&
        job.batchId === content.batchId &&
        job.retryId === content.id &&
        job.createdAt === content.createdAt) &&
      new Set(content.preservedCompletedItemIds).size ===
        content.preservedCompletedItemIds.length &&
      new Set(content.preservedArtifactIds).size ===
        content.preservedArtifactIds.length &&
      content.spentMinorUnitsBefore ===
        content.progressBefore.spentMinorUnits &&
      content.spentMinorUnitsAfter ===
        content.progressAfter.spentMinorUnits &&
      content.remainingMinorUnitsBefore ===
        content.progressBefore.remainingMinorUnits &&
      content.remainingMinorUnitsAfter ===
        content.progressAfter.remainingMinorUnits &&
      content.spentMinorUnitsAfter === content.spentMinorUnitsBefore &&
      content.remainingMinorUnitsAfter ===
        content.remainingMinorUnitsBefore,
    'PERSISTENCE_CONFLICT',
    'Batch partial retry aggregate is inconsistent',
  )
  const retryHash = calculateCanonicalHash(retryBody(content))
  assertDomain(
    value.retryHash === retryHash,
    'PERSISTENCE_CONFLICT',
    'Batch partial retry hash is invalid',
  )
  return Object.freeze({ ...content, retryHash })
}

export function createBatchPartialRetry(input: {
  id: string
  batch: Readonly<ProductionBatch>
  expectedBatchRevision: number
  targets: readonly Readonly<BatchPartialRetryTarget>[]
  actorClientId: string
  createdAt: string
  createJobId: (
    target: Readonly<BatchPartialRetryTarget>,
    index: number,
  ) => string
}): Readonly<{
  retry: Readonly<BatchPartialRetryRun>
  batch: Readonly<ProductionBatch>
}> {
  const batch = hydrateProductionBatch(input.batch)
  const expectedBatchRevision = revision(
    input.expectedBatchRevision,
    'expectedBatchRevision',
  )
  assertDomain(
    batch.revision === expectedBatchRevision,
    'VERSION_CONFLICT',
    'Production batch revision is stale',
  )
  assertDomain(
    Array.isArray(input.targets) &&
      input.targets.length >= 1 &&
      input.targets.length <= 100,
    'INVALID_ARGUMENT',
    'targets must contain one to 100 failed item steps',
  )
  const createdAt = instant(input.createdAt, 'createdAt')
  assertDomain(
    Date.parse(createdAt) >= Date.parse(batch.updatedAt),
    'VERSION_CONFLICT',
    'Batch partial retry cannot move time backwards',
  )
  const retryId = identity(input.id, 'retry.id')
  const actorClientId = identity(
    input.actorClientId,
    'actorClientId',
  )
  const normalizedTargets = input.targets.map((target, index) =>
    Object.freeze({
      itemId: identity(target.itemId, `targets[${index}].itemId`),
      step: target.step,
      expectedItemRevision: revision(
        target.expectedItemRevision,
        `targets[${index}].expectedItemRevision`,
      ),
      expectedStepHash: hash(
        target.expectedStepHash,
        `targets[${index}].expectedStepHash`,
      ),
    }))
  assertDomain(
    new Set(normalizedTargets.map((target) => target.itemId)).size ===
      normalizedTargets.length,
    'INVALID_ARGUMENT',
    'targets must contain at most one failed step per item',
  )

  const changedByItemId = new Map<string, ProductionBatch['items'][number]>()
  const jobs = normalizedTargets.map((target, index) => {
    const item = batch.items.find((candidate) =>
      candidate.id === target.itemId)
    assertDomain(
      Boolean(item),
      'PRODUCTION_BATCH_ITEM_NOT_FOUND',
      `Production batch item ${target.itemId} was not found`,
    )
    assertDomain(
      item!.revision === target.expectedItemRevision,
      'VERSION_CONFLICT',
      `Production batch item ${target.itemId} revision is stale`,
    )
    const failedStep = item!.steps.find((candidate) =>
      candidate.step === target.step)
    assertDomain(
      item!.state === 'failed' &&
        failedStep?.state === 'failed' &&
        failedStep.stepHash === target.expectedStepHash &&
        Boolean(failedStep.error),
      'VERSION_CONFLICT',
      `Production batch item ${target.itemId} failed step is stale`,
    )
    const changed = transitionBatchItem({
      item: item!,
      action: 'retry-step',
      step: target.step,
      now: createdAt,
    })
    changedByItemId.set(item!.id, changed)
    const queuedStep = changed.steps.find((candidate) =>
      candidate.step === target.step)!
    const lineageKey = calculateCanonicalHash({
      schemaVersion: BATCH_PARTIAL_RETRY_LINEAGE_VERSION,
      workspaceId: batch.workspaceId,
      batchId: batch.id,
      batchDefinitionHash: batch.definitionHash,
      itemId: item!.id,
      step: target.step,
    })
    const content = Object.freeze({
      schemaVersion: BATCH_PARTIAL_RETRY_JOB_SCHEMA_VERSION,
      id: identity(
        input.createJobId(target, index),
        `jobs[${index}].id`,
      ),
      workspaceId: batch.workspaceId,
      projectId: batch.projectId,
      batchId: batch.id,
      retryId,
      itemId: item!.id,
      step: target.step,
      executorClass: executorClass(target.step),
      status: 'queued' as const,
      lineageKey,
      failedAttempt: failedStep!.attempt,
      retryAttempt: failedStep!.attempt + 1,
      previousStepHash: failedStep!.stepHash,
      queuedStepHash: queuedStep.stepHash,
      failureCode: failedStep!.error!.code,
      failureMessage: failedStep!.error!.message,
      preservedArtifactIds: Object.freeze([...item!.artifactIds]),
      preservedArtifactCount: item!.artifactIds.length,
      chargedMinorUnitsAtEnqueue: 0 as const,
      createdAt,
    })
    return Object.freeze({
      ...content,
      jobHash: calculateCanonicalHash(jobBody(content)),
    })
  })

  const nextBatch = hydrateProductionBatch(Object.freeze({
    ...batch,
    revision: batch.revision + 1,
    items: Object.freeze(batch.items.map((item) =>
      changedByItemId.get(item.id) ?? item)),
    updatedAt: createdAt,
  }))
  const progressBefore = batchProgress(batch)
  const progressAfter = batchProgress(nextBatch)
  assertDomain(
    progressAfter.spentMinorUnits === progressBefore.spentMinorUnits &&
      progressAfter.remainingMinorUnits ===
        progressBefore.remainingMinorUnits,
    'PERSISTENCE_CONFLICT',
    'Enqueuing a retry must not charge the batch',
  )
  const preservedCompletedItemIds = Object.freeze(
    batch.items
      .filter((item) => item.state === 'completed')
      .map((item) => item.id),
  )
  assertDomain(
    preservedCompletedItemIds.every((itemId) =>
      nextBatch.items.find((item) => item.id === itemId)?.state ===
        'completed'),
    'PERSISTENCE_CONFLICT',
    'Batch partial retry changed a completed item',
  )
  const preservedArtifactIds = Object.freeze([
    ...new Set(batch.items.flatMap((item) => item.artifactIds)),
  ])
  assertDomain(
    preservedArtifactIds.every((artifactId) =>
      nextBatch.items.some((item) =>
        item.artifactIds.includes(artifactId))),
    'PERSISTENCE_CONFLICT',
    'Batch partial retry removed a valid artifact',
  )
  const content = Object.freeze({
    schemaVersion: BATCH_PARTIAL_RETRY_SCHEMA_VERSION,
    id: retryId,
    workspaceId: batch.workspaceId,
    projectId: batch.projectId,
    batchId: batch.id,
    batchDefinitionHash: batch.definitionHash,
    batchRevisionBefore: batch.revision,
    batchRevisionAfter: nextBatch.revision,
    status: 'queued' as const,
    jobs: Object.freeze(jobs),
    targetCount: jobs.length,
    preservedCompletedItemIds,
    preservedArtifactIds,
    progressBefore,
    progressAfter,
    spentMinorUnitsBefore: progressBefore.spentMinorUnits,
    spentMinorUnitsAfter: progressAfter.spentMinorUnits,
    remainingMinorUnitsBefore: progressBefore.remainingMinorUnits,
    remainingMinorUnitsAfter: progressAfter.remainingMinorUnits,
    createdByClientId: actorClientId,
    createdAt,
  })
  const retry = Object.freeze({
    ...content,
    retryHash: calculateCanonicalHash(retryBody(content)),
  })
  return Object.freeze({
    retry: hydrateBatchPartialRetry(retry),
    batch: nextBatch,
  })
}
