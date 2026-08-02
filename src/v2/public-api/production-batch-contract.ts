import type {
  CreateProductionBatchRequest,
} from '../application/production-batches.ts'
import { DomainError } from '../domain/errors.ts'
import {
  batchProgress,
  deriveBatchStatus,
  PRODUCTION_BATCH_STEPS,
  type BatchItemAction,
  type ProductionBatch,
  type ProductionBatchStep,
} from '../domain/production-batch.ts'
import { presentProductionBatchVisibleStates } from '../domain/visible-state.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) =>
    !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains unknown fields`,
      { fields: unknown },
    )
  }
}

function string(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = 500,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} characters`,
    )
  }
  return value.trim()
}

function integer(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = 100_000_000,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return Number(value)
}

function array(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = 1_000,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} entries`,
    )
  }
  return value
}

function stringArray(
  value: unknown,
  field: string,
  maximum = 1_000,
): readonly string[] {
  return Object.freeze(
    array(value, field, 1, maximum).map((entry, index) =>
      string(entry, `${field}[${index}]`, 1, 128)),
  )
}

export function parseCreateProductionBatchBody(
  raw: unknown,
): Omit<
  CreateProductionBatchRequest,
  'workspaceId' | 'actor' | 'idempotencyKey'
> {
  const body = record(raw, 'body')
  exactFields(body, [
    'projectId',
    'name',
    'objective',
    'sourceGroups',
    'recipes',
    'variants',
    'budget',
    'items',
  ], 'body')
  const sourceGroups = array(
    body.sourceGroups,
    'sourceGroups',
    1,
    100,
  ).map((entry, index) => {
    const group = record(entry, `sourceGroups[${index}]`)
    exactFields(
      group,
      ['id', 'name', 'sourceArtifactIds'],
      `sourceGroups[${index}]`,
    )
    return Object.freeze({
      id: string(group.id, `sourceGroups[${index}].id`, 3, 128),
      name: string(group.name, `sourceGroups[${index}].name`, 1, 160),
      sourceArtifactIds: stringArray(
        group.sourceArtifactIds,
        `sourceGroups[${index}].sourceArtifactIds`,
      ),
    })
  })
  const recipes = array(
    body.recipes,
    'recipes',
    1,
    250,
  ).map((entry, index) => {
    const recipe = record(entry, `recipes[${index}]`)
    exactFields(
      recipe,
      ['id', 'name', 'sourceGroupIds'],
      `recipes[${index}]`,
    )
    return Object.freeze({
      id: string(recipe.id, `recipes[${index}].id`, 3, 128),
      name: string(recipe.name, `recipes[${index}].name`, 1, 160),
      sourceGroupIds: stringArray(
        recipe.sourceGroupIds,
        `recipes[${index}].sourceGroupIds`,
        100,
      ),
    })
  })
  const variants = array(
    body.variants,
    'variants',
    1,
    50,
  ).map((entry, index) => {
    const variant = record(entry, `variants[${index}]`)
    exactFields(
      variant,
      ['id', 'name', 'outputSpecId', 'locale'],
      `variants[${index}]`,
    )
    return Object.freeze({
      id: string(variant.id, `variants[${index}].id`, 3, 128),
      name: string(variant.name, `variants[${index}].name`, 1, 160),
      outputSpecId: string(
        variant.outputSpecId,
        `variants[${index}].outputSpecId`,
        1,
        128,
      ),
      locale: string(
        variant.locale,
        `variants[${index}].locale`,
        2,
        35,
      ),
    })
  })
  const budget = record(body.budget, 'budget')
  exactFields(
    budget,
    ['currency', 'maxCostMinorUnits', 'reservedCostMinorUnits'],
    'budget',
  )
  const items = array(body.items, 'items', 1, 1_000)
    .map((entry, index) => {
      const item = record(entry, `items[${index}]`)
      exactFields(
        item,
        ['key', 'sourceGroupId', 'recipeId', 'variantId'],
        `items[${index}]`,
      )
      return Object.freeze({
        key: string(item.key, `items[${index}].key`, 1, 128),
        sourceGroupId: string(
          item.sourceGroupId,
          `items[${index}].sourceGroupId`,
          3,
          128,
        ),
        recipeId: string(
          item.recipeId,
          `items[${index}].recipeId`,
          3,
          128,
        ),
        variantId: string(
          item.variantId,
          `items[${index}].variantId`,
          3,
          128,
        ),
      })
    })
  return Object.freeze({
    projectId: string(body.projectId, 'projectId', 3, 128),
    name: string(body.name, 'name', 1, 200),
    objective: string(body.objective, 'objective', 1, 128),
    sourceGroups: Object.freeze(sourceGroups),
    recipes: Object.freeze(recipes),
    variants: Object.freeze(variants),
    budget: Object.freeze({
      currency: string(budget.currency, 'budget.currency', 3, 3) as 'USD',
      maxCostMinorUnits: integer(
        budget.maxCostMinorUnits,
        'budget.maxCostMinorUnits',
      ),
      reservedCostMinorUnits: integer(
        budget.reservedCostMinorUnits,
        'budget.reservedCostMinorUnits',
      ),
    }),
    items: Object.freeze(items),
  })
}

const ITEM_ACTIONS = new Set<BatchItemAction>([
  'start-step',
  'complete-step',
  'fail-step',
  'cancel',
  'resume',
  'retry-step',
])

export function parseProductionBatchItemActionBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(body, [
    'action',
    'step',
    'expectedBatchRevision',
    'expectedItemRevision',
    'costMinorUnits',
    'cacheHit',
    'error',
    'artifactIds',
  ], 'body')
  const action = string(body.action, 'action', 3, 32) as BatchItemAction
  if (!ITEM_ACTIONS.has(action)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'action is not supported for a production batch item',
    )
  }
  let step: ProductionBatchStep | undefined
  if (body.step !== undefined) {
    step = string(body.step, 'step', 3, 32) as ProductionBatchStep
    if (!PRODUCTION_BATCH_STEPS.includes(step)) {
      throw new DomainError('INVALID_ARGUMENT', 'step is invalid')
    }
  }
  let error: Readonly<{ code: string; message: string }> | undefined
  if (body.error !== undefined) {
    const input = record(body.error, 'error')
    exactFields(input, ['code', 'message'], 'error')
    error = Object.freeze({
      code: string(input.code, 'error.code', 1, 128),
      message: string(input.message, 'error.message', 1, 500),
    })
  }
  if (body.cacheHit !== undefined && typeof body.cacheHit !== 'boolean') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'cacheHit must be a boolean',
    )
  }
  return Object.freeze({
    action,
    ...(step ? { step } : {}),
    expectedBatchRevision: integer(
      body.expectedBatchRevision,
      'expectedBatchRevision',
      1,
      1_000_000,
    ),
    expectedItemRevision: integer(
      body.expectedItemRevision,
      'expectedItemRevision',
      1,
      1_000_000,
    ),
    ...(body.costMinorUnits !== undefined
      ? {
          costMinorUnits: integer(
            body.costMinorUnits,
            'costMinorUnits',
          ),
        }
      : {}),
    ...(body.cacheHit !== undefined
      ? { cacheHit: body.cacheHit as boolean }
      : {}),
    ...(error ? { error } : {}),
    ...(body.artifactIds !== undefined
      ? {
          artifactIds: stringArray(
            body.artifactIds,
            'artifactIds',
            1_000,
          ),
        }
      : {}),
  })
}

export function parseProductionBatchActionBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    ['action', 'expectedBatchRevision'],
    'body',
  )
  const action = string(body.action, 'action', 3, 32)
  if (!['cancel', 'resume'].includes(action)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'action must be cancel or resume',
    )
  }
  return Object.freeze({
    action: action as 'cancel' | 'resume',
    expectedBatchRevision: integer(
      body.expectedBatchRevision,
      'expectedBatchRevision',
      1,
      1_000_000,
    ),
  })
}

export function presentProductionBatch(
  batch: Readonly<ProductionBatch>,
) {
  return Object.freeze({
    ...batch,
    status: deriveBatchStatus(batch),
    progress: batchProgress(batch),
  })
}

export function presentProductionBatchV2(
  batch: Readonly<ProductionBatch>,
) {
  const visibleStates = presentProductionBatchVisibleStates(batch)
  const itemStates = new Map(visibleStates.items.map((item) => [
    item.itemId,
    item.visibleState,
  ]))
  return Object.freeze({
    ...batch,
    items: Object.freeze(batch.items.map((item) => Object.freeze({
      ...item,
      visibleState: itemStates.get(item.id)!,
    }))),
    status: deriveBatchStatus(batch),
    progress: batchProgress(batch),
    visibleState: visibleStates.batch,
  })
}

export function presentProductionBatchPageV2(input: {
  batches: readonly Readonly<ProductionBatch>[]
  nextCursor?: string
}) {
  return Object.freeze({
    batches: Object.freeze(input.batches.map(presentProductionBatchV2)),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}

export function presentProductionBatchPage(input: {
  batches: readonly Readonly<ProductionBatch>[]
  nextCursor?: string
}) {
  return Object.freeze({
    batches: Object.freeze(input.batches.map(presentProductionBatch)),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}
