import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createBatchPartialRetry,
  hydrateBatchPartialRetry,
} from '../../src/v2/domain/batch-partial-retry.ts'
import {
  batchProgress,
  createProductionBatch,
  hydrateProductionBatch,
  transitionBatchItem,
} from '../../src/v2/domain/production-batch.ts'
import {
  parseCreateBatchPartialRetryBody,
} from '../../src/v2/public-api/batch-partial-retry-contract.ts'

const at = (second) =>
  new Date(Date.UTC(2026, 6, 28, 15, 0, second)).toISOString()

function fixture() {
  return createProductionBatch({
    id: 'retry-batch-fixture',
    workspaceId: 'retry-workspace',
    projectId: 'retry-project',
    name: 'Mixed retry fixture',
    objective: 'conversion',
    sourceGroups: [{
      id: 'retry-sources',
      name: 'Approved source',
      sourceArtifactIds: ['retry-source-artifact'],
    }],
    recipes: [{
      id: 'retry-recipe',
      name: 'Retry recipe',
      sourceGroupIds: ['retry-sources'],
    }],
    variants: [
      { id: 'retry-9x16', name: '9:16', outputSpecId: '9:16', locale: 'pt-BR' },
      { id: 'retry-1x1', name: '1:1', outputSpecId: '1:1', locale: 'pt-BR' },
      { id: 'retry-16x9', name: '16:9', outputSpecId: '16:9', locale: 'pt-BR' },
      { id: 'retry-4x5', name: '4:5', outputSpecId: '4:5', locale: 'pt-BR' },
    ],
    budget: {
      currency: 'USD',
      maxCostMinorUnits: 100_000,
      reservedCostMinorUnits: 0,
    },
    itemDefinitions: [
      {
        id: 'retry-item-completed',
        key: 'completed',
        sourceGroupId: 'retry-sources',
        recipeId: 'retry-recipe',
        variantId: 'retry-9x16',
      },
      {
        id: 'retry-item-provider',
        key: 'provider',
        sourceGroupId: 'retry-sources',
        recipeId: 'retry-recipe',
        variantId: 'retry-1x1',
      },
      {
        id: 'retry-item-renderer',
        key: 'renderer',
        sourceGroupId: 'retry-sources',
        recipeId: 'retry-recipe',
        variantId: 'retry-16x9',
      },
      {
        id: 'retry-item-validator',
        key: 'validator',
        sourceGroupId: 'retry-sources',
        recipeId: 'retry-recipe',
        variantId: 'retry-4x5',
      },
    ],
    createdBy: { type: 'api-client', id: 'retry-client' },
    createdAt: at(0),
  })
}

function replaceItem(batch, item) {
  return hydrateProductionBatch({
    ...batch,
    revision: batch.revision + 1,
    items: batch.items.map((candidate) =>
      candidate.id === item.id ? item : candidate),
    updatedAt: item.updatedAt,
  })
}

function act(batch, itemId, action, second, input = {}) {
  const item = batch.items.find((candidate) => candidate.id === itemId)
  assert.ok(item)
  return replaceItem(batch, transitionBatchItem({
    item,
    action,
    now: at(second),
    ...input,
  }))
}

function completeThrough(
  batch,
  itemId,
  lastStep,
  startSecond,
  artifactPrefix,
) {
  const steps = ['planning', 'materializing', 'rendering', 'reviewing']
  let next = batch
  for (const [index, step] of steps.entries()) {
    next = act(next, itemId, 'start-step', startSecond + index * 2, { step })
    next = act(next, itemId, 'complete-step', startSecond + index * 2 + 1, {
      step,
      costMinorUnits: index + 1,
      artifactIds: [`${artifactPrefix}-${step}`],
    })
    if (step === lastStep) break
  }
  return next
}

function failAt(
  batch,
  itemId,
  step,
  second,
  code,
) {
  let next = act(batch, itemId, 'start-step', second, { step })
  next = act(next, itemId, 'fail-step', second + 1, {
    step,
    costMinorUnits: 7,
    cacheHit: false,
    error: {
      code,
      message: `${code} on the bounded fixture attempt`,
    },
  })
  return next
}

function mixedFailureFixture() {
  let batch = completeThrough(
    fixture(),
    'retry-item-completed',
    'reviewing',
    1,
    'artifact-completed',
  )
  batch = completeThrough(
    batch,
    'retry-item-provider',
    'planning',
    10,
    'artifact-provider',
  )
  batch = failAt(
    batch,
    'retry-item-provider',
    'materializing',
    12,
    'PROVIDER_TIMEOUT',
  )
  batch = completeThrough(
    batch,
    'retry-item-renderer',
    'materializing',
    20,
    'artifact-renderer',
  )
  batch = failAt(
    batch,
    'retry-item-renderer',
    'rendering',
    24,
    'RENDER_PROCESS_EXITED',
  )
  batch = completeThrough(
    batch,
    'retry-item-validator',
    'rendering',
    30,
    'artifact-validator',
  )
  batch = failAt(
    batch,
    'retry-item-validator',
    'reviewing',
    36,
    'VALIDATOR_REJECTED',
  )
  return batch
}

function targets(batch) {
  return [
    ['retry-item-provider', 'materializing'],
    ['retry-item-renderer', 'rendering'],
    ['retry-item-validator', 'reviewing'],
  ].map(([itemId, step]) => {
    const item = batch.items.find((candidate) => candidate.id === itemId)
    const failed = item.steps.find((candidate) => candidate.step === step)
    return {
      itemId,
      step,
      expectedItemRevision: item.revision,
      expectedStepHash: failed.stepHash,
    }
  })
}

test('T-FR-087 queues only provider, renderer and validator failures with stable lineage', () => {
  const batch = mixedFailureFixture()
  const before = batchProgress(batch)
  const result = createBatchPartialRetry({
    id: 'batch-partial-retry-fixture',
    batch,
    expectedBatchRevision: batch.revision,
    targets: targets(batch),
    actorClientId: 'retry-client',
    createdAt: at(40),
    createJobId: (_target, index) => `retry-job-${index + 1}`,
  })

  assert.deepEqual(
    result.retry.jobs.map((job) => job.executorClass),
    ['provider', 'renderer', 'validator'],
  )
  assert.deepEqual(
    result.retry.jobs.map((job) => job.step),
    ['materializing', 'rendering', 'reviewing'],
  )
  assert.ok(result.retry.jobs.every((job) =>
    job.status === 'queued' &&
    job.retryAttempt === job.failedAttempt + 1 &&
    job.chargedMinorUnitsAtEnqueue === 0 &&
    /^[a-f0-9]{64}$/.test(job.lineageKey)))
  assert.equal(result.batch.revision, batch.revision + 1)
  assert.equal(
    result.batch.items.find((item) =>
      item.id === 'retry-item-completed').state,
    'completed',
  )
  assert.equal(
    result.batch.items.find((item) =>
      item.id === 'retry-item-provider').steps[0].state,
    'completed',
  )
  assert.equal(
    result.batch.items.find((item) =>
      item.id === 'retry-item-provider').steps[1].state,
    'queued',
  )
  assert.equal(result.retry.spentMinorUnitsBefore, before.spentMinorUnits)
  assert.equal(result.retry.spentMinorUnitsAfter, before.spentMinorUnits)
  assert.equal(
    result.retry.remainingMinorUnitsAfter,
    before.remainingMinorUnits,
  )
  assert.deepEqual(
    [...result.retry.preservedArtifactIds].sort(),
    [...new Set(batch.items.flatMap((item) => item.artifactIds))].sort(),
  )
  assert.deepEqual(
    result.retry.preservedCompletedItemIds,
    ['retry-item-completed'],
  )
  assert.equal(
    hydrateBatchPartialRetry(result.retry).retryHash,
    result.retry.retryHash,
  )
})

test('T-FR-087 keeps paid cost unchanged when a retried provider step is a cache hit', () => {
  const batch = mixedFailureFixture()
  const result = createBatchPartialRetry({
    id: 'batch-partial-retry-cache',
    batch,
    expectedBatchRevision: batch.revision,
    targets: [targets(batch)[0]],
    actorClientId: 'retry-client',
    createdAt: at(40),
    createJobId: () => 'retry-job-cache',
  })
  const before = batchProgress(result.batch)
  let next = act(
    result.batch,
    'retry-item-provider',
    'start-step',
    41,
    { step: 'materializing' },
  )
  next = act(
    next,
    'retry-item-provider',
    'complete-step',
    42,
    {
      step: 'materializing',
      costMinorUnits: 99_999,
      cacheHit: true,
      artifactIds: ['artifact-provider-materialized-cache'],
    },
  )
  assert.equal(batchProgress(next).spentMinorUnits, before.spentMinorUnits)
  assert.equal(
    next.items.find((item) => item.id === 'retry-item-provider')
      .steps.find((step) => step.step === 'materializing').attempt,
    2,
  )
})

test('T-FR-087 fails atomically on stale item or step evidence', () => {
  const batch = mixedFailureFixture()
  const valid = targets(batch)
  assert.throws(() => createBatchPartialRetry({
    id: 'batch-partial-retry-stale-item',
    batch,
    expectedBatchRevision: batch.revision,
    targets: [{ ...valid[0], expectedItemRevision: 1 }],
    actorClientId: 'retry-client',
    createdAt: at(40),
    createJobId: () => 'retry-job-stale-item',
  }), /revision is stale/)
  assert.throws(() => createBatchPartialRetry({
    id: 'batch-partial-retry-stale-step',
    batch,
    expectedBatchRevision: batch.revision,
    targets: [{ ...valid[0], expectedStepHash: '0'.repeat(64) }],
    actorClientId: 'retry-client',
    createdAt: at(40),
    createJobId: () => 'retry-job-stale-step',
  }), /failed step is stale/)
  assert.equal(
    batch.items.find((item) => item.id === 'retry-item-provider').state,
    'failed',
  )
})

test('T-FR-087 public contract accepts only exact revision and failed-step evidence', () => {
  const parsed = parseCreateBatchPartialRetryBody({
    expectedBatchRevision: 12,
    targets: [{
      itemId: 'retry-item-provider',
      step: 'materializing',
      expectedItemRevision: 7,
      expectedStepHash: 'a'.repeat(64),
    }],
  })
  assert.equal(parsed.expectedBatchRevision, 12)
  assert.equal(parsed.targets[0].step, 'materializing')
  assert.throws(
    () => parseCreateBatchPartialRetryBody({
      expectedBatchRevision: 12,
      targets: [{
        itemId: 'retry-item-provider',
        step: 'materializing',
        expectedItemRevision: 7,
        expectedStepHash: 'a'.repeat(64),
        hiddenFallback: true,
      }],
    }),
    /unknown fields/,
  )
  assert.throws(
    () => parseCreateBatchPartialRetryBody({
      expectedBatchRevision: 12,
      targets: [
        {
          itemId: 'retry-item-provider',
          step: 'materializing',
          expectedItemRevision: 7,
          expectedStepHash: 'a'.repeat(64),
        },
        {
          itemId: 'retry-item-provider',
          step: 'rendering',
          expectedItemRevision: 7,
          expectedStepHash: 'b'.repeat(64),
        },
      ],
    }),
    /at most one failed step per item/,
  )
})
