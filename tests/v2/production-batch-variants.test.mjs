import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyBatchEdit,
  batchProgress,
  buildCompatibilityGraph,
  cancelProductionBatch,
  compileVariantRecipe,
  createProductionBatch,
  deriveBatchStatus,
  hydrateProductionBatch,
  previewBatchEdit,
  resumeProductionBatch,
  retryBatchStep,
  transitionBatchItem,
  variantSpacePreflight,
} from '../../src/v2/domain/production-batch.ts'

const at = (second) =>
  new Date(Date.UTC(2026, 6, 27, 18, 0, second)).toISOString()

function batchFixture() {
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
    budget: {
      currency: 'USD',
      maxCostMinorUnits: 10_000,
      reservedCostMinorUnits: 3_000,
    },
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

test('T-FR-083 records compatibility hard blocks, scores, and evidence', () => {
  const node = (id, patch = {}) => ({
    id,
    role: 'hook',
    offer: 'offer',
    audience: 'audience',
    persona: 'persona',
    locale: 'pt-BR',
    tone: 0.5,
    energy: 0.5,
    durationMs: 5000,
    visual: 0.5,
    experiment: 0.5,
    ...patch,
  })
  const graph = buildCompatibilityGraph([
    node('accepted'),
    node('accepted-two'),
    node('border', { tone: 1, energy: 1 }),
    node('blocked', { offer: 'other-offer' }),
  ])
  assert.equal(graph.edges.length, 6)
  assert.ok(graph.edges.some((edge) => edge.eligible && edge.softScore === 1))
  assert.ok(graph.edges.some((edge) => edge.eligible && edge.softScore < 1))
  assert.ok(graph.edges.some((edge) =>
    !edge.eligible &&
    edge.hardReasonCodes.includes('OFFER_MISMATCH')))
  assert.ok(graph.edges.every((edge) => edge.evidence.from))
})

test('T-FR-084 compiles complete and short recipes by reference with lineage', () => {
  const recipe = {
    id: 'recipe-one',
    selection: {
      hookId: 'hook',
      bodyId: 'body',
      proofId: 'proof',
      ctaId: 'cta',
    },
    order: ['hook', 'body', 'proof', 'cta'],
    sourceSegmentIds: ['segment-hook', 'segment-body', 'segment-proof', 'segment-cta'],
    assumptions: [],
    scores: { narrative: 0.9 },
    coldOpen: {
      sourceSegmentId: 'segment-proof',
      returnAtMs: 2000,
    },
  }
  const result = compileVariantRecipe(recipe, { proofRequired: true })
  assert.equal(result.editPlan.duplicatesMasters, false)
  assert.equal(result.lineage.length, 4)
  assert.equal(result.storyPlan.coldOpen.sourceSegmentId, 'segment-proof')
  const short = compileVariantRecipe({
    ...recipe,
    selection: {
      hookId: 'hook',
      bodyId: 'body',
      ctaId: 'cta',
    },
    order: ['hook', 'body', 'cta'],
  }, { proofRequired: false })
  assert.equal(short.lineage.length, 3)
  assert.throws(
    () => compileVariantRecipe({
      ...recipe,
      selection: {
        hookId: 'hook',
        bodyId: 'body',
        ctaId: 'cta',
      },
    }, { proofRequired: true }),
  )
})

test('T-FR-085 preflights variants without materializing the uncontrolled product', () => {
  const node = (id, role) => ({
    id,
    role,
    offer: 'offer',
    audience: 'audience',
    persona: 'persona',
    locale: 'pt-BR',
    tone: 0.5,
    energy: 0.5,
    durationMs: 1000,
    visual: 0.5,
    experiment: 0.5,
  })
  const result = variantSpacePreflight({
    hooks: [node('hook-one', 'hook'), node('hook-two', 'hook')],
    bodies: [node('body-one', 'body'), node('body-two', 'body')],
    proofs: [node('proof', 'proof')],
    ctas: [node('cta-one', 'cta'), node('cta-two', 'cta')],
    topN: 8,
    threshold: 0.5,
    budget: 3,
    unitCost: 1,
    defaultLimit: 2,
  })
  assert.equal(result.theoretical, 8)
  assert.equal(result.selected.length, 2)
  assert.equal(result.productMaterialized, false)
  assert.equal(result.confirmationRequired, true)
  assert.ok(result.expectedReuse > 0)
})

test('T-FR-086 previews protected impacts and applies explicit transaction policy', () => {
  for (const operation of [
    'replace-cta',
    'subtitle-style',
    'brand-kit',
  ]) {
    const command = {
      id: operation,
      recipeIds: ['recipe-one', 'recipe-two'],
      formatIds: ['9:16'],
      targetIds: ['safe', 'protected'],
      operation,
      value: 'new-value',
      policy: 'skip-failures',
    }
    const preview = previewBatchEdit(command, {
      protectedTargetIds: ['protected'],
      itemCosts: { 'recipe-one:9:16:safe': 1 },
    })
    assert.equal(preview.conflicts.length, 2)
    assert.ok(preview.sampleDiff.length)
    const result = applyBatchEdit(command, preview)
    assert.equal(result.status, 'partial')
    assert.ok(result.results.some((entry) => entry.status === 'applied'))
    assert.equal(
      applyBatchEdit(
        { ...command, policy: 'all-or-nothing' },
        preview,
      ).status,
      'rolled-back',
    )
  }
})
