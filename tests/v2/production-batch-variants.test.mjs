import assert from 'node:assert/strict'
import test from 'node:test'

import {
  batchProgress,
  cancelProductionBatch,
  createProductionBatch,
  deriveBatchStatus,
  hydrateProductionBatch,
  resumeProductionBatch,
  retryBatchStep,
  transitionBatchItem,
} from '../../src/v2/domain/production-batch.ts'
import {
  createProductionBatchBudgetThresholdEvents,
  PRODUCTION_BATCH_BUDGET_THRESHOLD_POLICY_VERSION,
} from '../../src/v2/domain/production-batch-budget-event.ts'
import {
  presentProductionBatchVisibleStates,
} from '../../src/v2/domain/visible-state.ts'
import {
  presentProductionBatchV2,
} from '../../src/v2/public-api/production-batch-contract.ts'

const at = (second) =>
  new Date(Date.UTC(2026, 6, 27, 18, 0, second)).toISOString()

function batchFixture(budget = {
  currency: 'USD',
  maxCostMinorUnits: 10_000,
  reservedCostMinorUnits: 3_000,
}) {
  return createProductionBatch({
    id: 'batch-fixture-001',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    name: 'Campanha de descoberta',
    objective: 'content-distribution',
    sourceGroups: [
      {
        id: 'group-hooks',
        name: 'Hooks',
        sourceArtifactIds: ['artifact-hook-a', 'artifact-hook-b'],
      },
      {
        id: 'group-body',
        name: 'Corpo e CTA',
        sourceArtifactIds: ['artifact-body-a'],
      },
    ],
    recipes: [
      {
        id: 'recipe-hook',
        name: 'Hook validado',
        sourceGroupIds: ['group-hooks'],
      },
      {
        id: 'recipe-complete',
        name: 'Argumento completo',
        sourceGroupIds: ['group-body'],
      },
    ],
    variants: [
      {
        id: 'variant-vertical',
        name: 'Vertical',
        outputSpecId: '9:16',
        locale: 'pt-BR',
      },
      {
        id: 'variant-square',
        name: 'Quadrado',
        outputSpecId: '1:1',
        locale: 'pt-BR',
      },
    ],
    budget,
    itemDefinitions: [
      {
        id: 'batch-item-one',
        key: 'hook/vertical',
        sourceGroupId: 'group-hooks',
        recipeId: 'recipe-hook',
        variantId: 'variant-vertical',
      },
      {
        id: 'batch-item-two',
        key: 'hook/square',
        sourceGroupId: 'group-hooks',
        recipeId: 'recipe-hook',
        variantId: 'variant-square',
      },
      {
        id: 'batch-item-three',
        key: 'body/vertical',
        sourceGroupId: 'group-body',
        recipeId: 'recipe-complete',
        variantId: 'variant-vertical',
      },
    ],
    createdBy: {
      type: 'api-client',
      id: 'api-client-fixture',
    },
    createdAt: at(0),
  })
}

const budgetAudit = Object.freeze({
  clientId: 'api-client-fixture',
  credentialId: 'credential-fixture',
  workspaceId: 'workspace-fixture',
  environment: 'production',
  authenticationKind: 'bearer',
  contextHash: 'a'.repeat(64),
})

function budgetEvents(previousBatch, resultingBatch, ids) {
  let index = 0
  return createProductionBatchBudgetThresholdEvents({
    previousBatch,
    resultingBatch,
    authenticationAudit: budgetAudit,
    occurredAt: resultingBatch.updatedAt,
    createEventId: () => ids[index++],
  })
}

function replaceItem(batch, item) {
  return Object.freeze({
    ...batch,
    revision: batch.revision + 1,
    items: Object.freeze(
      batch.items.map((candidate) =>
        candidate.id === item.id ? item : candidate),
    ),
    updatedAt: item.updatedAt,
  })
}

function actOnItem(batch, itemId, action, second, rest = {}) {
  const item = batch.items.find((candidate) => candidate.id === itemId)
  assert.ok(item, `missing fixture item ${itemId}`)
  return replaceItem(
    batch,
    transitionBatchItem({
      item,
      action,
      now: at(second),
      ...rest,
    }),
  )
}

function completeItem(batch, itemId, firstSecond, artifactId) {
  let next = batch
  const steps = ['planning', 'materializing', 'rendering', 'reviewing']
  for (const [index, step] of steps.entries()) {
    next = actOnItem(
      next,
      itemId,
      'start-step',
      firstSecond + index * 2,
      { step },
    )
    next = actOnItem(
      next,
      itemId,
      'complete-step',
      firstSecond + index * 2 + 1,
      {
        step,
        costMinorUnits: index + 1,
        ...(step === 'reviewing' ? { artifactIds: [artifactId] } : {}),
      },
    )
  }
  return next
}

test('T-FR-080 creates an immutable explicit batch without materializing a Cartesian product', () => {
  const batch = batchFixture()
  assert.equal(batch.items.length, 3)
  assert.equal(
    batch.sourceGroups.length *
      batch.recipes.length *
      batch.variants.length,
    8,
  )
  assert.equal(deriveBatchStatus(batch), 'queued')
  assert.deepEqual(batchProgress(batch), {
    completedSteps: 0,
    failedSteps: 0,
    cancelledSteps: 0,
    runningSteps: 0,
    totalSteps: 12,
    percent: 0,
    completedItems: 0,
    failedItems: 0,
    cancelledItems: 0,
    activeItems: 0,
    queuedItems: 3,
    totalItems: 3,
    spentMinorUnits: 0,
    remainingMinorUnits: 10_000,
  })
  assert.match(batch.definitionHash, /^[a-f0-9]{64}$/)
  assert.match(batch.items[0].itemHash, /^[a-f0-9]{64}$/)
  assert.throws(() => batch.items.push(batch.items[0]))
  assert.throws(() => batch.sourceGroups[0].sourceArtifactIds.push('other'))
  assert.equal(hydrateProductionBatch(batch).definitionHash, batch.definitionHash)
})

test('T-FR-128 emits canonical budget thresholds only when persisted consumption crosses them', () => {
  const ids = [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
  ]
  let batch = batchFixture({
    currency: 'USD',
    maxCostMinorUnits: 100,
    reservedCostMinorUnits: 100,
  })
  const zero = batch
  batch = actOnItem(batch, 'batch-item-one', 'start-step', 1, {
    step: 'planning',
  })
  assert.deepEqual(budgetEvents(zero, batch, ids), [])

  const beforeFirstCharge = batch
  batch = actOnItem(batch, 'batch-item-one', 'complete-step', 2, {
    step: 'planning',
    costMinorUnits: 79,
  })
  assert.deepEqual(budgetEvents(beforeFirstCharge, batch, ids), [])
  batch = actOnItem(batch, 'batch-item-one', 'start-step', 3, {
    step: 'materializing',
  })
  const beforeCrossing = batch
  batch = actOnItem(batch, 'batch-item-one', 'complete-step', 4, {
    step: 'materializing',
    costMinorUnits: 21,
  })

  const events = budgetEvents(beforeCrossing, batch, ids)
  assert.equal(events.length, 2)
  assert.deepEqual(events.map((event) => event.data.thresholdBasisPoints), [
    8_000,
    10_000,
  ])
  assert.deepEqual(events[0], {
    id: ids[0],
    type: 'budget.threshold.reached',
    version: '1.0.0',
    workspaceId: 'workspace-fixture',
    occurredAt: at(4),
    actor: { clientId: 'api-client-fixture' },
    resource: { type: 'workspace', id: 'workspace-fixture' },
    data: {
      budgetScope: 'production-batch',
      policyVersion: PRODUCTION_BATCH_BUDGET_THRESHOLD_POLICY_VERSION,
      batchId: 'batch-fixture-001',
      projectId: 'project-fixture',
      currency: 'USD',
      thresholdBasisPoints: 8_000,
      thresholdLevel: 'warning',
      previousSpentMinorUnits: 79,
      spentMinorUnits: 100,
      maximumMinorUnits: 100,
    },
  })
  assert.equal(events[1].data.thresholdLevel, 'exhausted')
  assert.ok(Object.isFrozen(events))
  assert.ok(Object.isFrozen(events[0].data))
})

test('T-FR-128 emits each threshold once and rejects decreasing or foreign budget transitions', () => {
  const ids = [
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
  ]
  let batch = batchFixture({
    currency: 'USD',
    maxCostMinorUnits: 100,
    reservedCostMinorUnits: 0,
  })
  batch = actOnItem(batch, 'batch-item-one', 'start-step', 1, {
    step: 'planning',
  })
  const beforeWarning = batch
  batch = actOnItem(batch, 'batch-item-one', 'complete-step', 2, {
    step: 'planning',
    costMinorUnits: 80,
  })
  assert.deepEqual(
    budgetEvents(beforeWarning, batch, ids)
      .map((event) => event.data.thresholdLevel),
    ['warning'],
  )
  batch = actOnItem(batch, 'batch-item-one', 'start-step', 3, {
    step: 'materializing',
  })
  const beforeExhausted = batch
  batch = actOnItem(batch, 'batch-item-one', 'complete-step', 4, {
    step: 'materializing',
    costMinorUnits: 20,
  })
  assert.deepEqual(
    budgetEvents(beforeExhausted, batch, ids.slice(1))
      .map((event) => event.data.thresholdLevel),
    ['exhausted'],
  )
  assert.throws(
    () => budgetEvents(batch, beforeExhausted, ids),
    (error) => error?.code === 'PERSISTENCE_CONFLICT' &&
      /monotonic/.test(error.message),
  )
  assert.throws(
    () => createProductionBatchBudgetThresholdEvents({
      previousBatch: beforeExhausted,
      resultingBatch: batch,
      authenticationAudit: {
        ...budgetAudit,
        workspaceId: 'workspace-foreign',
      },
      occurredAt: batch.updatedAt,
      createEventId: () => ids[0],
    }),
    (error) => error?.code === 'PERSISTENCE_CONFLICT' &&
      /bound to one budget/.test(error.message),
  )
})

test('T-FR-080 derives partial progress from real steps and resumes only unfinished items', () => {
  let batch = batchFixture()
  batch = completeItem(batch, 'batch-item-one', 1, 'artifact-final-one')
  batch = actOnItem(
    batch,
    'batch-item-two',
    'start-step',
    10,
    { step: 'planning' },
  )
  batch = actOnItem(
    batch,
    'batch-item-two',
    'complete-step',
    11,
    {
      step: 'planning',
      costMinorUnits: 1,
      artifactIds: ['artifact-plan-two'],
    },
  )
  batch = actOnItem(
    batch,
    'batch-item-two',
    'start-step',
    12,
    { step: 'materializing' },
  )
  batch = actOnItem(
    batch,
    'batch-item-two',
    'fail-step',
    13,
    {
      step: 'materializing',
      costMinorUnits: 5,
      error: {
        code: 'PROVIDER_TIMEOUT',
        message: 'Provider timed out after the bounded attempt.',
      },
    },
  )
  batch = actOnItem(batch, 'batch-item-three', 'cancel', 14)

  assert.equal(deriveBatchStatus(batch), 'partially-completed')
  assert.deepEqual(batchProgress(batch), {
    completedSteps: 5,
    failedSteps: 1,
    cancelledSteps: 4,
    runningSteps: 0,
    totalSteps: 12,
    percent: 41,
    completedItems: 1,
    failedItems: 1,
    cancelledItems: 1,
    activeItems: 0,
    queuedItems: 0,
    totalItems: 3,
    spentMinorUnits: 16,
    remainingMinorUnits: 9_984,
  })

  const cancelled = cancelProductionBatch({
    batch,
    now: at(15),
  })
  assert.equal(cancelled.items[0].state, 'completed')
  assert.deepEqual(cancelled.items[0].artifactIds, ['artifact-final-one'])
  assert.equal(cancelled.items[1].state, 'cancelled')

  const resumed = resumeProductionBatch({
    batch: cancelled,
    now: at(16),
  })
  assert.equal(resumed.items[0].state, 'completed')
  assert.equal(resumed.items[1].state, 'queued')
  assert.equal(resumed.items[2].state, 'queued')
  assert.deepEqual(resumed.items[0].artifactIds, ['artifact-final-one'])
  assert.deepEqual(resumed.items[1].artifactIds, ['artifact-plan-two'])
  assert.equal(batchProgress(resumed).spentMinorUnits, 16)
  assert.equal(
    hydrateProductionBatch(resumed).definitionHash,
    batch.definitionHash,
  )
})

test('T-FR-087 retries only a failed step and preserves artifacts, lineage, and paid cost', () => {
  let batch = batchFixture()
  batch = completeItem(batch, 'batch-item-one', 1, 'artifact-final-one')
  batch = actOnItem(
    batch,
    'batch-item-two',
    'start-step',
    10,
    { step: 'planning' },
  )
  batch = actOnItem(
    batch,
    'batch-item-two',
    'complete-step',
    11,
    {
      step: 'planning',
      costMinorUnits: 2,
      artifactIds: ['artifact-plan-two'],
    },
  )
  batch = actOnItem(
    batch,
    'batch-item-two',
    'start-step',
    12,
    { step: 'materializing' },
  )
  batch = actOnItem(
    batch,
    'batch-item-two',
    'fail-step',
    13,
    {
      step: 'materializing',
      costMinorUnits: 7,
      error: {
        code: 'PROVIDER_REJECTED',
        message: 'Provider rejected this bounded request.',
      },
    },
  )
  const spentBeforeRetry = batchProgress(batch).spentMinorUnits
  const result = retryBatchStep(batch, {
    itemId: 'batch-item-two',
    step: 'materializing',
    provider: 'provider-fixture',
    now: at(14),
  })

  assert.equal(result.batch.items[0].state, 'completed')
  assert.equal(result.batch.items[1].state, 'queued')
  assert.deepEqual(
    result.batch.items[1].steps.map((step) => step.state),
    ['completed', 'queued', 'queued', 'queued'],
  )
  assert.deepEqual(
    [...result.preservedArtifactIds].sort(),
    ['artifact-final-one', 'artifact-plan-two'].sort(),
  )
  assert.deepEqual(result.lineage, {
    batchId: batch.id,
    itemId: 'batch-item-two',
    step: 'materializing',
    attempt: 2,
    provider: 'provider-fixture',
  })
  assert.equal(result.progress.spentMinorUnits, spentBeforeRetry)

  let retried = actOnItem(
    result.batch,
    'batch-item-two',
    'start-step',
    15,
    { step: 'materializing' },
  )
  retried = actOnItem(
    retried,
    'batch-item-two',
    'complete-step',
    16,
    {
      step: 'materializing',
      costMinorUnits: 999,
      cacheHit: true,
    },
  )
  assert.equal(
    retried.items[1].steps[1].attempt,
    2,
  )
  assert.equal(batchProgress(retried).spentMinorUnits, spentBeforeRetry)
})

test('T-FR-080 rejects incompatible dimensions, stale transitions, and integrity tampering', () => {
  const batch = batchFixture()
  assert.throws(
    () => createProductionBatch({
      ...batchFixture(),
      itemDefinitions: [
        {
          id: 'batch-item-invalid',
          key: 'invalid',
          sourceGroupId: 'group-body',
          recipeId: 'recipe-hook',
          variantId: 'variant-vertical',
        },
      ],
    }),
    /incompatible dimension/,
  )
  assert.throws(
    () => transitionBatchItem({
      item: batch.items[0],
      action: 'start-step',
      step: 'planning',
      now: at(-1),
    }),
    /move time backwards/,
  )
  const tampered = {
    ...batch,
    name: 'Definition changed outside the command path',
  }
  assert.throws(
    () => hydrateProductionBatch(tampered),
    /integrity validation/,
  )
  const invalidItem = {
    ...batch.items[0],
    state: 'completed',
  }
  assert.throws(
    () => hydrateProductionBatch({
      ...batch,
      items: [invalidItem, ...batch.items.slice(1)],
    }),
    /state does not match/,
  )
})

test('T-FR-236 exposes partial batch failure and exact per-item progress without inventing completion', () => {
  let batch = completeItem(batchFixture(), 'batch-item-one', 1, 'artifact-one')
  batch = completeItem(batch, 'batch-item-three', 20, 'artifact-three')
  batch = actOnItem(batch, 'batch-item-two', 'start-step', 40, { step: 'planning' })
  batch = actOnItem(batch, 'batch-item-two', 'complete-step', 41, { step: 'planning' })
  batch = actOnItem(batch, 'batch-item-two', 'start-step', 42, { step: 'materializing' })
  batch = actOnItem(batch, 'batch-item-two', 'fail-step', 43, {
    step: 'materializing',
    error: { code: 'PROVIDER_TIMEOUT', message: 'Provider timed out.' },
  })

  const states = presentProductionBatchVisibleStates(batch)
  assert.deepEqual(states.batch, {
    schemaVersion: 'visible-state/v1',
    label: 'partially-failed',
    tone: 'danger',
    progress: { mode: 'determinate', percent: 75 },
    primaryAction: 'retry-failed',
    availableActions: ['retry-failed', 'inspect-error', 'open-results'],
    terminal: true,
  })
  assert.equal(states.items[0].visibleState.label, 'completed')
  assert.deepEqual(states.items[1].visibleState.progress, {
    mode: 'determinate',
    percent: 25,
  })
  assert.equal(states.items[1].visibleState.label, 'failed')
  assert.equal(states.items[2].visibleState.primaryAction, 'open-result')
  assert.throws(() => states.items.push(states.items[0]))

  const publicBatch = presentProductionBatchV2(batch)
  assert.equal(publicBatch.visibleState.label, 'partially-failed')
  assert.equal(publicBatch.items[1].visibleState.primaryAction, 'retry')
  assert.equal(publicBatch.progress.percent, 75)
  assert.equal(publicBatch.items[1].error.code, 'PROVIDER_TIMEOUT')

  assert.throws(
    () => presentProductionBatchVisibleStates({
      ...batch,
      items: [{ ...batch.items[0], state: 'invented' }, ...batch.items.slice(1)],
    }),
    /state is invalid/,
  )
})
