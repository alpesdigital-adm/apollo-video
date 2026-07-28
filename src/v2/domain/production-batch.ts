import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { ScriptBlockRole } from './script-alignment.ts'

const stableOperationId = (value: unknown) => { const text = JSON.stringify(value); let hash = 2166136261; for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619); return (hash >>> 0).toString(16).padStart(8, '0') }

export const PRODUCTION_BATCH_POLICY_VERSION =
  'production-batch/v1' as const
export const PRODUCTION_BATCH_SCHEMA_VERSION =
  'production-batch/v1' as const

export const PRODUCTION_BATCH_STEPS = [
  'planning',
  'materializing',
  'rendering',
  'reviewing',
] as const

export type ProductionBatchStep =
  (typeof PRODUCTION_BATCH_STEPS)[number]
export type BatchStepState =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type BatchItemState =
  | 'queued'
  | 'planning'
  | 'materializing'
  | 'rendering'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded'
export type ProductionBatchStatus =
  | 'queued'
  | 'running'
  | 'review'
  | 'partially-completed'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ProductionBatchSourceGroup {
  id: string
  name: string
  sourceArtifactIds: readonly string[]
}

export interface ProductionBatchRecipe {
  id: string
  name: string
  sourceGroupIds: readonly string[]
}

export interface ProductionBatchVariant {
  id: string
  name: string
  outputSpecId: string
  locale: string
}

export interface BatchItemError {
  code: string
  message: string
}

export interface BatchItemStep {
  step: ProductionBatchStep
  sequence: number
  state: BatchStepState
  attempt: number
  costMinorUnits: number
  cacheHit: boolean
  error?: Readonly<BatchItemError>
  stepHash: string
}

export interface BatchItem {
  id: string
  key: string
  sourceGroupId: string
  recipeId: string
  variantId: string
  state: BatchItemState
  revision: number
  steps: readonly Readonly<BatchItemStep>[]
  artifactIds: readonly string[]
  retryCount: number
  error?: Readonly<BatchItemError>
  createdAt: string
  updatedAt: string
  itemHash: string
}

export interface ProductionBatch {
  schemaVersion: typeof PRODUCTION_BATCH_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  name: string
  objective: string
  policyVersion: typeof PRODUCTION_BATCH_POLICY_VERSION
  revision: number
  sourceGroups: readonly Readonly<ProductionBatchSourceGroup>[]
  recipes: readonly Readonly<ProductionBatchRecipe>[]
  variants: readonly Readonly<ProductionBatchVariant>[]
  budget: Readonly<{
    currency: 'USD'
    maxCostMinorUnits: number
    reservedCostMinorUnits: number
  }>
  items: readonly Readonly<BatchItem>[]
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  updatedAt: string
  definitionHash: string
}

export interface ProductionBatchProgress {
  completedSteps: number
  failedSteps: number
  cancelledSteps: number
  runningSteps: number
  totalSteps: number
  percent: number
  completedItems: number
  failedItems: number
  cancelledItems: number
  activeItems: number
  queuedItems: number
  totalItems: number
  spentMinorUnits: number
  remainingMinorUnits: number
}

export type BatchItemAction =
  | 'start-step'
  | 'complete-step'
  | 'fail-step'
  | 'cancel'
  | 'resume'
  | 'retry-step'

const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const BATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/

function normalizedToken(
  value: unknown,
  field: string,
  pattern: RegExp = BATCH_ID,
): string {
  assertDomain(
    typeof value === 'string' && pattern.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function normalizedLabel(
  value: unknown,
  field: string,
  maximum = 160,
): string {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : ''
  assertDomain(
    normalized.length >= 1 && normalized.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function normalizedInstant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function normalizedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return Number(value)
}

function uniqueTokens(
  values: readonly string[],
  field: string,
): readonly string[] {
  assertDomain(
    Array.isArray(values) &&
      values.length > 0 &&
      values.length <= 1_000,
    'INVALID_ARGUMENT',
    `${field} must contain one to 1,000 values`,
  )
  const normalized = values.map((value, index) =>
    normalizedToken(value, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicate values`,
  )
  return Object.freeze(normalized)
}

function itemStepHash(
  step: Omit<BatchItemStep, 'stepHash'>,
): string {
  return calculateCanonicalHash(step)
}

function itemHash(
  item: Omit<BatchItem, 'itemHash'>,
): string {
  return calculateCanonicalHash(item)
}

type BatchItemStepInput =
  Omit<BatchItemStep, 'stepHash'> &
  Partial<Pick<BatchItemStep, 'stepHash'>>

type BatchItemInput =
  Omit<BatchItem, 'itemHash' | 'steps'> & {
    steps: readonly BatchItemStepInput[]
  } & Partial<Pick<BatchItem, 'itemHash'>>

function freezeError(
  error: Readonly<BatchItemError> | undefined,
): Readonly<BatchItemError> | undefined {
  if (!error) return undefined
  return Object.freeze({
    code: normalizedToken(error.code, 'error.code', BATCH_KEY),
    message: normalizedLabel(error.message, 'error.message', 500),
  })
}

function freezeStep(
  input: BatchItemStepInput,
): Readonly<BatchItemStep> {
  assertDomain(
    PRODUCTION_BATCH_STEPS.includes(input.step) &&
      input.sequence === PRODUCTION_BATCH_STEPS.indexOf(input.step) &&
      ['queued', 'running', 'completed', 'failed', 'cancelled']
        .includes(input.state) &&
      (input.state === 'failed') === Boolean(input.error),
    'INVALID_ARGUMENT',
    'Batch item step identity, state, or error is invalid',
  )
  const content = Object.freeze({
    step: input.step,
    sequence: input.sequence,
    state: input.state,
    attempt: normalizedInteger(
      input.attempt,
      `${input.step}.attempt`,
      0,
      10_000,
    ),
    costMinorUnits: normalizedInteger(
      input.costMinorUnits,
      `${input.step}.costMinorUnits`,
      0,
      10_000_000,
    ),
    cacheHit: Boolean(input.cacheHit),
    ...(input.error ? { error: freezeError(input.error)! } : {}),
  })
  const hash = itemStepHash(content)
  assertDomain(
    input.stepHash === undefined || input.stepHash === hash,
    'PERSISTENCE_CONFLICT',
    `Batch item step ${input.step} failed integrity validation`,
  )
  return Object.freeze({ ...content, stepHash: hash })
}

function freezeItem(
  input: BatchItemInput,
): Readonly<BatchItem> {
  const steps = Object.freeze(
    [...input.steps]
      .sort((left, right) => left.sequence - right.sequence)
      .map((step) => freezeStep(step)),
  )
  assertDomain(
    steps.length === PRODUCTION_BATCH_STEPS.length &&
      steps.every((step, index) =>
        step.step === PRODUCTION_BATCH_STEPS[index]),
    'INVALID_ARGUMENT',
    'Batch item must contain the canonical four steps',
  )
  assertDomain(
    [
      'queued',
      'planning',
      'materializing',
      'rendering',
      'reviewing',
      'completed',
      'failed',
      'cancelled',
      'superseded',
    ].includes(input.state),
    'INVALID_ARGUMENT',
    'Batch item state is invalid',
  )
  const runningSteps = steps.filter((step) => step.state === 'running')
  const failedSteps = steps.filter((step) => step.state === 'failed')
  const firstNonCompleted = steps.findIndex((step) =>
    step.state !== 'completed')
  const prefixIsCompleted = steps.every((step, index) =>
    firstNonCompleted < 0 ||
    index >= firstNonCompleted ||
    step.state === 'completed')
  const activeStep = runningSteps[0]
  assertDomain(
    prefixIsCompleted &&
      (
        (input.state === 'queued' &&
          runningSteps.length === 0 &&
          failedSteps.length === 0 &&
          steps.some((step) => step.state === 'queued')) ||
        (['planning', 'materializing', 'rendering', 'reviewing']
          .includes(input.state) &&
          runningSteps.length === 1 &&
          failedSteps.length === 0 &&
          activeStep?.step === input.state) ||
        (input.state === 'completed' &&
          steps.every((step) => step.state === 'completed')) ||
        (input.state === 'failed' &&
          runningSteps.length === 0 &&
          failedSteps.length === 1 &&
          Boolean(input.error)) ||
        (input.state === 'cancelled' &&
          runningSteps.length === 0 &&
          steps.every((step) =>
            ['completed', 'failed', 'cancelled'].includes(step.state))) ||
        (input.state === 'superseded' &&
          runningSteps.length === 0)
      ),
    'INVALID_ARGUMENT',
    'Batch item state does not match its step states',
  )
  const artifacts = Object.freeze(
    [...new Set(input.artifactIds.map((artifactId, index) =>
      normalizedToken(
        artifactId,
        `artifactIds[${index}]`,
      )))],
  )
  const content = Object.freeze({
    id: normalizedToken(input.id, 'item.id'),
    key: normalizedToken(input.key, 'item.key', BATCH_KEY),
    sourceGroupId: normalizedToken(
      input.sourceGroupId,
      'item.sourceGroupId',
    ),
    recipeId: normalizedToken(input.recipeId, 'item.recipeId'),
    variantId: normalizedToken(input.variantId, 'item.variantId'),
    state: input.state,
    revision: normalizedInteger(
      input.revision,
      'item.revision',
      1,
      1_000_000,
    ),
    steps,
    artifactIds: artifacts,
    retryCount: normalizedInteger(
      input.retryCount,
      'item.retryCount',
      0,
      10_000,
    ),
    ...(input.error ? { error: freezeError(input.error)! } : {}),
    createdAt: normalizedInstant(input.createdAt, 'item.createdAt'),
    updatedAt: normalizedInstant(input.updatedAt, 'item.updatedAt'),
  })
  const hash = itemHash(content)
  assertDomain(
    input.itemHash === undefined || input.itemHash === hash,
    'PERSISTENCE_CONFLICT',
    `Batch item ${content.id} failed integrity validation`,
  )
  return Object.freeze({ ...content, itemHash: hash })
}

function definitionHash(
  batch: Omit<ProductionBatch, 'items' | 'definitionHash'>,
): string {
  const {
    revision: _revision,
    updatedAt: _updatedAt,
    ...immutableDefinition
  } = batch
  return calculateCanonicalHash(immutableDefinition)
}

export function createProductionBatch(input: {
  id: string
  workspaceId: string
  projectId: string
  name: string
  objective: string
  revision?: number
  sourceGroups: readonly Readonly<ProductionBatchSourceGroup>[]
  recipes: readonly Readonly<ProductionBatchRecipe>[]
  variants: readonly Readonly<ProductionBatchVariant>[]
  budget: Readonly<{
    currency: 'USD'
    maxCostMinorUnits: number
    reservedCostMinorUnits: number
  }>
  itemDefinitions: readonly Readonly<{
    id: string
    key: string
    sourceGroupId: string
    recipeId: string
    variantId: string
  }>[]
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}): Readonly<ProductionBatch> {
  assertDomain(
    input.sourceGroups.length > 0 &&
      input.sourceGroups.length <= 100 &&
      input.recipes.length > 0 &&
      input.recipes.length <= 250 &&
      input.variants.length > 0 &&
      input.variants.length <= 50 &&
      input.itemDefinitions.length > 0 &&
      input.itemDefinitions.length <= 1_000,
    'INVALID_ARGUMENT',
    'Production batch dimensions are invalid',
  )
  const sourceGroups = Object.freeze(input.sourceGroups.map(
    (group, index) => Object.freeze({
      id: normalizedToken(group.id, `sourceGroups[${index}].id`),
      name: normalizedLabel(
        group.name,
        `sourceGroups[${index}].name`,
      ),
      sourceArtifactIds: uniqueTokens(
        group.sourceArtifactIds,
        `sourceGroups[${index}].sourceArtifactIds`,
      ),
    }),
  ))
  const sourceGroupIds = new Set(sourceGroups.map((group) => group.id))
  assertDomain(
    sourceGroupIds.size === sourceGroups.length,
    'INVALID_ARGUMENT',
    'Production batch source group IDs must be unique',
  )
  const recipes = Object.freeze(input.recipes.map(
    (recipe, index) => {
      const groupIds = uniqueTokens(
        recipe.sourceGroupIds,
        `recipes[${index}].sourceGroupIds`,
      )
      assertDomain(
        groupIds.every((groupId) => sourceGroupIds.has(groupId)),
        'INVALID_ARGUMENT',
        `recipes[${index}] references an unknown source group`,
      )
      return Object.freeze({
        id: normalizedToken(recipe.id, `recipes[${index}].id`),
        name: normalizedLabel(
          recipe.name,
          `recipes[${index}].name`,
        ),
        sourceGroupIds: groupIds,
      })
    },
  ))
  const recipeIds = new Set(recipes.map((recipe) => recipe.id))
  assertDomain(
    recipeIds.size === recipes.length,
    'INVALID_ARGUMENT',
    'Production batch recipe IDs must be unique',
  )
  const variants = Object.freeze(input.variants.map(
    (variant, index) => Object.freeze({
      id: normalizedToken(variant.id, `variants[${index}].id`),
      name: normalizedLabel(
        variant.name,
        `variants[${index}].name`,
      ),
      outputSpecId: normalizedToken(
        variant.outputSpecId,
        `variants[${index}].outputSpecId`,
        BATCH_KEY,
      ),
      locale: normalizedToken(
        variant.locale,
        `variants[${index}].locale`,
        LOCALE,
      ),
    }),
  ))
  const variantIds = new Set(variants.map((variant) => variant.id))
  assertDomain(
    variantIds.size === variants.length,
    'INVALID_ARGUMENT',
    'Production batch variant IDs must be unique',
  )
  assertDomain(
    input.budget.currency === 'USD',
    'INVALID_ARGUMENT',
    'Production batch budget must use USD',
  )
  const budget = Object.freeze({
    currency: 'USD' as const,
    maxCostMinorUnits: normalizedInteger(
      input.budget.maxCostMinorUnits,
      'budget.maxCostMinorUnits',
      0,
      100_000_000,
    ),
    reservedCostMinorUnits: normalizedInteger(
      input.budget.reservedCostMinorUnits,
      'budget.reservedCostMinorUnits',
      0,
      100_000_000,
    ),
  })
  assertDomain(
    budget.reservedCostMinorUnits <= budget.maxCostMinorUnits,
    'INVALID_ARGUMENT',
    'Reserved production batch budget exceeds its limit',
  )
  const createdAt = normalizedInstant(input.createdAt, 'createdAt')
  const items = Object.freeze(input.itemDefinitions.map(
    (definition, index) => {
      const sourceGroupId = normalizedToken(
        definition.sourceGroupId,
        `items[${index}].sourceGroupId`,
      )
      const recipeId = normalizedToken(
        definition.recipeId,
        `items[${index}].recipeId`,
      )
      const variantId = normalizedToken(
        definition.variantId,
        `items[${index}].variantId`,
      )
      const recipe = recipes.find((candidate) =>
        candidate.id === recipeId)
      assertDomain(
        sourceGroupIds.has(sourceGroupId) &&
          Boolean(recipe) &&
          recipe!.sourceGroupIds.includes(sourceGroupId) &&
          variantIds.has(variantId),
        'INVALID_ARGUMENT',
        `items[${index}] references an incompatible dimension`,
      )
      return freezeItem({
        id: definition.id,
        key: definition.key,
        sourceGroupId,
        recipeId,
        variantId,
        state: 'queued',
        revision: 1,
        steps: PRODUCTION_BATCH_STEPS.map((step, sequence) => ({
          step,
          sequence,
          state: 'queued' as const,
          attempt: 0,
          costMinorUnits: 0,
          cacheHit: false,
        })),
        artifactIds: [],
        retryCount: 0,
        createdAt,
        updatedAt: createdAt,
      })
    },
  ))
  const itemKeys = items.map((item) => item.key)
  const tuples = items.map((item) =>
    `${item.sourceGroupId}:${item.recipeId}:${item.variantId}`)
  assertDomain(
    new Set(itemKeys).size === itemKeys.length &&
      new Set(tuples).size === tuples.length,
    'INVALID_ARGUMENT',
    'Production batch items must have unique keys and combinations',
  )
  const content = Object.freeze({
    schemaVersion: PRODUCTION_BATCH_SCHEMA_VERSION,
    id: normalizedToken(input.id, 'batch.id'),
    workspaceId: normalizedToken(input.workspaceId, 'workspaceId'),
    projectId: normalizedToken(input.projectId, 'projectId'),
    name: normalizedLabel(input.name, 'name', 200),
    objective: normalizedToken(
      input.objective,
      'objective',
      BATCH_KEY,
    ),
    policyVersion: PRODUCTION_BATCH_POLICY_VERSION,
    revision: normalizedInteger(
      input.revision ?? 1,
      'revision',
      1,
      1_000_000,
    ),
    sourceGroups,
    recipes,
    variants,
    budget,
    createdBy: Object.freeze({
      type: input.createdBy.type,
      id: normalizedToken(input.createdBy.id, 'createdBy.id'),
    }),
    createdAt,
    updatedAt: createdAt,
  })
  assertDomain(
    content.createdBy.type === 'api-client',
    'AUTH_INVALID',
    'Production batch requires an API client actor',
  )
  return Object.freeze({
    ...content,
    items,
    definitionHash: definitionHash(content),
  })
}

export function hydrateProductionBatch(
  input: Readonly<ProductionBatch>,
): Readonly<ProductionBatch> {
  const sourceGroups = Object.freeze(input.sourceGroups.map((group) =>
    Object.freeze({
      ...group,
      sourceArtifactIds: uniqueTokens(
        group.sourceArtifactIds,
        `${group.id}.sourceArtifactIds`,
      ),
    })))
  const recipes = Object.freeze(input.recipes.map((recipe) =>
    Object.freeze({
      ...recipe,
      sourceGroupIds: uniqueTokens(
        recipe.sourceGroupIds,
        `${recipe.id}.sourceGroupIds`,
      ),
    })))
  const variants = Object.freeze(input.variants.map((variant) =>
    Object.freeze({ ...variant })))
  const items = Object.freeze(input.items.map((item) =>
    freezeItem(item)))
  const content = Object.freeze({
    schemaVersion: input.schemaVersion,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    name: input.name,
    objective: input.objective,
    policyVersion: input.policyVersion,
    revision: input.revision,
    sourceGroups,
    recipes,
    variants,
    budget: Object.freeze({ ...input.budget }),
    createdBy: Object.freeze({ ...input.createdBy }),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  })
  assertDomain(
    input.schemaVersion === PRODUCTION_BATCH_SCHEMA_VERSION &&
      input.policyVersion === PRODUCTION_BATCH_POLICY_VERSION &&
      definitionHash(content) === input.definitionHash,
    'PERSISTENCE_CONFLICT',
    `Production batch ${input.id} failed integrity validation`,
  )
  return Object.freeze({
    ...content,
    items,
    definitionHash: input.definitionHash,
  })
}

export function deriveBatchStatus(
  batch: Readonly<ProductionBatch>,
): ProductionBatchStatus {
  const states = batch.items.map((item) => item.state)
  if (states.every((state) => state === 'completed')) return 'completed'
  if (states.every((state) => state === 'cancelled')) return 'cancelled'
  if (states.every((state) => state === 'failed')) return 'failed'
  if (states.some((state) => state === 'reviewing')) return 'review'
  if (
    states.some((state) =>
      ['planning', 'materializing', 'rendering'].includes(state))
  ) {
    return 'running'
  }
  const terminal = states.filter((state) =>
    ['completed', 'failed', 'cancelled', 'superseded'].includes(state))
  if (terminal.length > 0) return 'partially-completed'
  return 'queued'
}

export function batchProgress(
  batch: Readonly<ProductionBatch>,
): Readonly<ProductionBatchProgress> {
  const steps = batch.items.flatMap((item) => item.steps)
  const countStep = (state: BatchStepState) =>
    steps.filter((step) => step.state === state).length
  const completedSteps = countStep('completed')
  const spentMinorUnits = steps
    .reduce((total, step) => total + step.costMinorUnits, 0)
  const result = {
    completedSteps,
    failedSteps: countStep('failed'),
    cancelledSteps: countStep('cancelled'),
    runningSteps: countStep('running'),
    totalSteps: steps.length,
    percent: steps.length === 0
      ? 0
      : Math.floor(completedSteps / steps.length * 100),
    completedItems: batch.items.filter((item) =>
      item.state === 'completed').length,
    failedItems: batch.items.filter((item) =>
      item.state === 'failed').length,
    cancelledItems: batch.items.filter((item) =>
      item.state === 'cancelled').length,
    activeItems: batch.items.filter((item) =>
      ['planning', 'materializing', 'rendering', 'reviewing']
        .includes(item.state)).length,
    queuedItems: batch.items.filter((item) =>
      item.state === 'queued').length,
    totalItems: batch.items.length,
    spentMinorUnits,
    remainingMinorUnits: Math.max(
      0,
      batch.budget.maxCostMinorUnits - spentMinorUnits,
    ),
  }
  return Object.freeze(result)
}

function transitionError(
  error: Readonly<BatchItemError> | undefined,
): Readonly<BatchItemError> {
  assertDomain(
    Boolean(error),
    'INVALID_ARGUMENT',
    'A failed batch item step requires an error',
  )
  return freezeError(error)!
}

function stepItemState(step: ProductionBatchStep): BatchItemState {
  return step
}

export function transitionBatchItem(input: {
  item: Readonly<BatchItem>
  action: BatchItemAction
  now: string
  step?: ProductionBatchStep
  costMinorUnits?: number
  cacheHit?: boolean
  error?: Readonly<BatchItemError>
  artifactIds?: readonly string[]
}): Readonly<BatchItem> {
  const item = freezeItem(input.item)
  const now = normalizedInstant(input.now, 'transition.now')
  assertDomain(
    Date.parse(now) >= Date.parse(item.updatedAt),
    'VERSION_CONFLICT',
    'Batch item transition cannot move time backwards',
  )
  const stepIndex = input.step === undefined
    ? -1
    : PRODUCTION_BATCH_STEPS.indexOf(input.step)
  const selected = stepIndex >= 0 ? item.steps[stepIndex] : undefined
  const steps = item.steps.map(({ stepHash: _stepHash, ...step }) => ({
    ...step,
  }))
  let state = item.state
  let error = item.error
  let retryCount = item.retryCount
  let artifactIds = [...item.artifactIds]

  if (input.action === 'start-step') {
    assertDomain(
      selected?.state === 'queued' &&
        item.state === 'queued' &&
        steps.slice(0, stepIndex).every((step) =>
          step.state === 'completed'),
      'VERSION_CONFLICT',
      'Batch item step cannot start from its current state',
    )
    steps[stepIndex] = {
      ...steps[stepIndex]!,
      state: 'running',
      attempt: selected.attempt + 1,
      error: undefined,
    }
    state = stepItemState(selected.step)
    error = undefined
  } else if (input.action === 'complete-step') {
    assertDomain(
      selected?.state === 'running' &&
        item.state === stepItemState(selected.step),
      'VERSION_CONFLICT',
      'Batch item step cannot complete from its current state',
    )
    steps[stepIndex] = {
      ...steps[stepIndex]!,
      state: 'completed',
      costMinorUnits: selected.costMinorUnits + (
        input.cacheHit ? 0 : normalizedInteger(
        input.costMinorUnits ?? 0,
        'costMinorUnits',
        0,
        10_000_000,
        )
      ),
      cacheHit: Boolean(input.cacheHit),
      error: undefined,
    }
    if (input.artifactIds) {
      artifactIds = [
        ...new Set([
          ...artifactIds,
          ...input.artifactIds.map((artifactId, index) =>
            normalizedToken(
              artifactId,
              `artifactIds[${index}]`,
            )),
        ]),
      ]
    }
    state = selected.step === 'reviewing' ? 'completed' : 'queued'
    error = undefined
  } else if (input.action === 'fail-step') {
    assertDomain(
      selected?.state === 'running' &&
        item.state === stepItemState(selected.step),
      'VERSION_CONFLICT',
      'Batch item step cannot fail from its current state',
    )
    const failure = transitionError(input.error)
    steps[stepIndex] = {
      ...steps[stepIndex]!,
      state: 'failed',
      costMinorUnits: selected.costMinorUnits + (
        input.cacheHit ? 0 : normalizedInteger(
        input.costMinorUnits ?? 0,
        'costMinorUnits',
        0,
        10_000_000,
        )
      ),
      cacheHit: Boolean(input.cacheHit),
      error: failure,
    }
    state = 'failed'
    error = failure
  } else if (input.action === 'cancel') {
    assertDomain(
      !['completed', 'cancelled', 'superseded'].includes(item.state),
      'VERSION_CONFLICT',
      'Batch item cannot be cancelled from its current state',
    )
    for (let index = 0; index < steps.length; index += 1) {
      if (['queued', 'running'].includes(steps[index]!.state)) {
        steps[index] = {
          ...steps[index]!,
          state: 'cancelled',
          error: undefined,
        }
      }
    }
    state = 'cancelled'
    error = undefined
  } else if (input.action === 'resume') {
    assertDomain(
      ['failed', 'cancelled'].includes(item.state),
      'VERSION_CONFLICT',
      'Batch item cannot resume from its current state',
    )
    for (let index = 0; index < steps.length; index += 1) {
      if (['failed', 'cancelled'].includes(steps[index]!.state)) {
        steps[index] = {
          ...steps[index]!,
          state: 'queued',
          error: undefined,
        }
      }
    }
    state = 'queued'
    error = undefined
    retryCount += 1
  } else {
    assertDomain(
      input.action === 'retry-step' &&
        item.state === 'failed' &&
        selected?.state === 'failed' &&
        steps.slice(0, stepIndex).every((step) =>
          step.state === 'completed'),
      'VERSION_CONFLICT',
      'Batch item step cannot be retried from its current state',
    )
    for (let index = stepIndex; index < steps.length; index += 1) {
      if (steps[index]!.state !== 'completed') {
        steps[index] = {
          ...steps[index]!,
          state: 'queued',
          error: undefined,
        }
      }
    }
    state = 'queued'
    error = undefined
    retryCount += 1
  }

  const { itemHash: _itemHash, ...itemContent } = item
  return freezeItem({
    ...itemContent,
    state,
    revision: item.revision + 1,
    steps,
    artifactIds,
    retryCount,
    ...(error ? { error } : { error: undefined }),
    updatedAt: now,
  })
}

export function cancelProductionBatch(input: {
  batch: Readonly<ProductionBatch>
  now: string
}): Readonly<ProductionBatch> {
  const batch = hydrateProductionBatch(input.batch)
  assertDomain(
    Date.parse(input.now) >= Date.parse(batch.updatedAt),
    'VERSION_CONFLICT',
    'Production batch cancellation cannot move time backwards',
  )
  const items = batch.items.map((item) =>
    ['completed', 'cancelled', 'superseded'].includes(item.state)
      ? item
      : transitionBatchItem({
          item,
          action: 'cancel',
          now: input.now,
        }))
  assertDomain(
    items.some((item, index) => item !== batch.items[index]),
    'VERSION_CONFLICT',
    'Production batch has no cancellable items',
  )
  return Object.freeze({
    ...batch,
    revision: batch.revision + 1,
    items: Object.freeze(items),
    updatedAt: normalizedInstant(input.now, 'cancel.now'),
  })
}

export function resumeProductionBatch(input: {
  batch: Readonly<ProductionBatch>
  now: string
}): Readonly<ProductionBatch> {
  const batch = hydrateProductionBatch(input.batch)
  assertDomain(
    Date.parse(input.now) >= Date.parse(batch.updatedAt),
    'VERSION_CONFLICT',
    'Production batch resume cannot move time backwards',
  )
  const items = batch.items.map((item) =>
    ['failed', 'cancelled'].includes(item.state)
      ? transitionBatchItem({
          item,
          action: 'resume',
          now: input.now,
        })
      : item)
  assertDomain(
    items.some((item, index) => item !== batch.items[index]),
    'VERSION_CONFLICT',
    'Production batch has no resumable items',
  )
  return Object.freeze({
    ...batch,
    revision: batch.revision + 1,
    items: Object.freeze(items),
    updatedAt: normalizedInstant(input.now, 'resume.now'),
  })
}

interface VariantSpaceNode { id: string; offer: string; audience: string; persona: string; locale: string; tone: number; energy: number; durationMs: number; visual: number; experiment: number }
function variantSpaceEdge(from: VariantSpaceNode, to: VariantSpaceNode) { const eligible = from.offer === to.offer && from.audience === to.audience && from.persona === to.persona && from.locale === to.locale; const similarity = (a: number, b: number) => 1 - Math.min(1, Math.abs(a - b)); const softScore = (similarity(from.tone, to.tone) + similarity(from.energy, to.energy) + similarity(from.durationMs / 60_000, to.durationMs / 60_000) + similarity(from.visual, to.visual) + similarity(from.experiment, to.experiment)) / 5; return { eligible, softScore } }
export function variantSpacePreflight(input: { hooks: readonly VariantSpaceNode[]; bodies: readonly VariantSpaceNode[]; proofs: readonly VariantSpaceNode[]; ctas: readonly VariantSpaceNode[]; topN: number; threshold: number; budget: number; unitCost: number; defaultLimit: number; confirmedExpansion?: boolean }) { const theoretical = input.hooks.length * input.bodies.length * Math.max(1, input.proofs.length) * input.ctas.length; const candidates: { ids: readonly string[]; score: number }[] = []; for (const hook of input.hooks) for (const body of input.bodies) for (const proof of input.proofs.length ? input.proofs : [null]) for (const cta of input.ctas) { const chain = [hook, body, ...(proof ? [proof] : []), cta]; const edges = chain.slice(0, -1).map((node, index) => variantSpaceEdge(node, chain[index + 1])); if (edges.every((edge) => edge.eligible) && edges.reduce((sum, edge) => sum + edge.softScore, 0) / edges.length >= input.threshold) candidates.push({ ids: Object.freeze(chain.map((node) => node.id)), score: edges.reduce((sum, edge) => sum + edge.softScore, 0) / edges.length }) } const deduped = [...new Map(candidates.map((item) => [item.ids.join(':'), item])).values()].sort((a, b) => b.score - a.score); const affordable = Math.floor(input.budget / input.unitCost); const limit = Math.min(input.topN, affordable, input.confirmedExpansion ? input.topN : input.defaultLimit); const selected: typeof deduped = []; const coverage = new Set<string>(); for (const candidate of deduped) { const diversity = candidate.ids.filter((id) => !coverage.has(id)).length; if (selected.length < limit && (diversity > 0 || selected.length < Math.min(input.hooks.length, input.bodies.length, input.ctas.length))) { selected.push(candidate); candidate.ids.forEach((id) => coverage.add(id)) } } return Object.freeze({ theoretical, eligible: deduped.length, selected: Object.freeze(selected), estimatedCost: selected.length * input.unitCost, estimatedTimeUnits: selected.length, expectedReuse: theoretical ? 1 - selected.length / theoretical : 0, confirmationRequired: input.topN > input.defaultLimit && !input.confirmedExpansion, productMaterialized: false }) }

export interface BatchEditCommand { id: string; recipeIds: readonly string[]; formatIds: readonly string[]; targetIds: readonly string[]; operation: 'replace-cta' | 'subtitle-style' | 'brand-kit'; value: string; policy: 'all-or-nothing' | 'skip-failures' }
export function previewBatchEdit(command: BatchEditCommand, input: { protectedTargetIds: readonly string[]; itemCosts: Readonly<Record<string, number>> }) { const affected = command.recipeIds.flatMap((recipeId) => command.formatIds.flatMap((formatId) => command.targetIds.map((targetId) => ({ id: `${recipeId}:${formatId}:${targetId}`, recipeId, formatId, targetId })))); const conflicts = affected.filter((item) => input.protectedTargetIds.includes(item.targetId)); return Object.freeze({ affected: Object.freeze(affected), conflicts: Object.freeze(conflicts), invalidatedRanges: Object.freeze(affected.map((item) => item.id)), estimatedCost: affected.reduce((sum, item) => sum + (input.itemCosts[item.id] ?? 0), 0), sampleDiff: Object.freeze(affected.slice(0, 3).map((item) => ({ id: item.id, before: 'current', after: command.value }))) }) }
export function applyBatchEdit(command: BatchEditCommand, preview: ReturnType<typeof previewBatchEdit>) { if (command.policy === 'all-or-nothing' && preview.conflicts.length) return Object.freeze({ status: 'rolled-back', results: Object.freeze(preview.affected.map((item) => ({ id: item.id, status: 'not-applied' }))) }); const failed = new Set(preview.conflicts.map((item) => item.id)); return Object.freeze({ status: failed.size ? 'partial' : 'committed', transactionId: `batch_edit_${stableOperationId(command)}`, results: Object.freeze(preview.affected.map((item) => ({ id: item.id, status: failed.has(item.id) ? 'skipped' : 'applied' }))) }) }

export function retryBatchStep(
  batchInput: Readonly<ProductionBatch>,
  input: {
    itemId: string
    step: ProductionBatchStep
    provider: string
    now: string
  },
) {
  const batch = hydrateProductionBatch(batchInput)
  const itemIndex = batch.items.findIndex((item) =>
    item.id === input.itemId)
  assertDomain(
    itemIndex >= 0,
    'PRODUCTION_BATCH_ITEM_NOT_FOUND',
    `Production batch item ${input.itemId} was not found`,
  )
  const current = batch.items[itemIndex]!
  const failedStep = current.steps.find((step) =>
    step.step === input.step)
  assertDomain(
    failedStep?.state === 'failed',
    'VERSION_CONFLICT',
    `Production batch step ${input.step} is not failed`,
  )
  const retried = transitionBatchItem({
    item: current,
    action: 'retry-step',
    step: input.step,
    now: input.now,
  })
  const items = [...batch.items]
  items[itemIndex] = retried
  const next = Object.freeze({
    ...batch,
    revision: batch.revision + 1,
    items: Object.freeze(items),
    updatedAt: normalizedInstant(input.now, 'retry.now'),
  })
  return Object.freeze({
    batch: next,
    lineage: Object.freeze({
      batchId: batch.id,
      itemId: input.itemId,
      step: input.step,
      attempt: failedStep.attempt + 1,
      provider: normalizedToken(input.provider, 'provider', BATCH_KEY),
    }),
    progress: batchProgress(next),
    preservedArtifactIds: Object.freeze(
      batch.items.flatMap((item) => item.artifactIds),
    ),
  })
}
