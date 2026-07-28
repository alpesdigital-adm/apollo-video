import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  PRODUCTION_BATCH_STEPS,
  type ProductionBatchStep,
} from './production-batch.ts'

export const BATCH_EDIT_POLICY_SCHEMA_VERSION =
  'batch-edit-policy/v1' as const
export const BATCH_EDIT_ITEM_STATE_SCHEMA_VERSION =
  'batch-edit-item-state/v1' as const
export const BATCH_EDIT_PREFLIGHT_SCHEMA_VERSION =
  'batch-edit-preflight/v1' as const
export const BATCH_EDIT_COMMAND_SCHEMA_VERSION =
  'batch-edit-command/v1' as const
export const BATCH_EDIT_IMPACT_VERSION =
  'batch-edit-impact/v1' as const

export const BATCH_EDIT_OPERATION_TYPES = [
  'replace-cta',
  'subtitle-style',
  'brand-kit',
] as const

export type BatchEditOperationType =
  (typeof BATCH_EDIT_OPERATION_TYPES)[number]
export type BatchEditMode =
  'all-or-nothing' | 'skip-failures'
export type BatchEditPreflightStatus =
  'ready' | 'partial-ready' | 'blocked' | 'no-change'
export type BatchEditItemDisposition =
  'applicable' | 'protected' | 'unchanged'
export type BatchEditCommandStatus = 'committed' | 'partial'
export type BatchEditItemResultStatus =
  'applied' | 'skipped' | 'unchanged'

export interface BatchEditOperation {
  type: BatchEditOperationType
  valueRef: string
}

export interface BatchEditScope {
  recipeIds: readonly string[]
  outputSpecIds: readonly string[]
  itemIds: readonly string[]
  scopeHash: string
}

export interface BatchEditPolicy {
  schemaVersion: typeof BATCH_EDIT_POLICY_SCHEMA_VERSION
  workspaceId: string
  revision: number
  defaultMode: BatchEditMode
  maxItemCount: number
  diffSampleSize: number
  replaceCtaCostMinorUnits: number
  subtitleStyleCostMinorUnits: number
  brandKitCostMinorUnits: number
  confirmationTtlSeconds: number
  updatedByClientId: string
  updatedAt: string
  policyHash: string
}

export interface BatchEditItemDirectives {
  ctaRef?: string
  subtitleStyleId?: string
  brandKitSnapshotId?: string
}

export interface BatchEditItemState {
  schemaVersion: typeof BATCH_EDIT_ITEM_STATE_SCHEMA_VERSION
  workspaceId: string
  batchId: string
  itemId: string
  revision: number
  directives: Readonly<BatchEditItemDirectives>
  protectedOperations: readonly BatchEditOperationType[]
  previousStateHash?: string
  sourceCommandId?: string
  createdByClientId: string
  createdAt: string
  stateHash: string
}

export interface BatchEditItemContext {
  itemId: string
  recipeId: string
  variantId: string
  outputSpecId: string
  locale: string
  state: Readonly<BatchEditItemState>
}

export interface BatchEditItemImpact {
  itemId: string
  recipeId: string
  variantId: string
  outputSpecId: string
  locale: string
  targetRef: string
  disposition: BatchEditItemDisposition
  beforeValueRef?: string
  afterValueRef: string
  beforeStateRevision: number
  beforeStateHash: string
  protectedConflict: boolean
  conflictCodes: readonly string[]
  invalidatedSteps: readonly ProductionBatchStep[]
  invalidatedTargetRefs: readonly string[]
  estimatedCostMinorUnits: number
  impactHash: string
}

export interface BatchEditSampleDiff {
  itemId: string
  recipeId: string
  outputSpecId: string
  targetRef: string
  before: Readonly<{
    mode: 'inherit' | 'override'
    valueRef?: string
  }>
  after: Readonly<{
    mode: 'override'
    valueRef: string
  }>
  disposition: BatchEditItemDisposition
  conflictCodes: readonly string[]
  diffHash: string
}

export interface BatchEditPreflightRun {
  schemaVersion: typeof BATCH_EDIT_PREFLIGHT_SCHEMA_VERSION
  impactVersion: typeof BATCH_EDIT_IMPACT_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  batchRevision: number
  batchDefinitionHash: string
  policy: Readonly<BatchEditPolicy>
  mode: BatchEditMode
  operation: Readonly<BatchEditOperation>
  scope: Readonly<BatchEditScope>
  status: BatchEditPreflightStatus
  budgetRemainingMinorUnits: number
  affectedItemCount: number
  applicableItemCount: number
  protectedConflictCount: number
  unchangedItemCount: number
  invalidationCount: number
  estimatedCostMinorUnits: number
  budgetExceeded: boolean
  impacts: readonly Readonly<BatchEditItemImpact>[]
  sampleDiff: readonly Readonly<BatchEditSampleDiff>[]
  warningCodes: readonly string[]
  confirmationExpiresAt?: string
  costFingerprint: string
  createdByClientId: string
  createdAt: string
  preflightHash: string
}

export interface BatchEditItemResult {
  itemId: string
  recipeId: string
  variantId: string
  outputSpecId: string
  targetRef: string
  status: BatchEditItemResultStatus
  beforeStateRevision: number
  beforeStateHash: string
  afterStateRevision?: number
  afterStateHash?: string
  conflictCodes: readonly string[]
  invalidatedSteps: readonly ProductionBatchStep[]
  invalidatedTargetRefs: readonly string[]
  costMinorUnits: number
  resultHash: string
}

export interface BatchEditCommand {
  schemaVersion: typeof BATCH_EDIT_COMMAND_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  preflightId: string
  preflightHash: string
  batchRevision: number
  batchDefinitionHash: string
  policyHash: string
  mode: BatchEditMode
  operation: Readonly<BatchEditOperation>
  scope: Readonly<BatchEditScope>
  status: BatchEditCommandStatus
  resultItems: readonly Readonly<BatchEditItemResult>[]
  newStates: readonly Readonly<BatchEditItemState>[]
  affectedItemCount: number
  appliedItemCount: number
  skippedItemCount: number
  unchangedItemCount: number
  invalidationCount: number
  costMinorUnits: number
  createdByClientId: string
  createdAt: string
  commandHash: string
}

export interface CreateBatchEditPolicyInput {
  workspaceId: string
  revision?: number
  defaultMode?: BatchEditMode
  maxItemCount?: number
  diffSampleSize?: number
  replaceCtaCostMinorUnits?: number
  subtitleStyleCostMinorUnits?: number
  brandKitCostMinorUnits?: number
  confirmationTtlSeconds?: number
  updatedByClientId: string
  updatedAt: string
}

export interface CreateBatchEditItemStateInput {
  workspaceId: string
  batchId: string
  itemId: string
  revision?: number
  directives?: Readonly<BatchEditItemDirectives>
  protectedOperations?: readonly BatchEditOperationType[]
  previousStateHash?: string
  sourceCommandId?: string
  createdByClientId: string
  createdAt: string
}

export interface CreateBatchEditPreflightInput {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  batchRevision: number
  batchDefinitionHash: string
  policy: Readonly<BatchEditPolicy>
  mode?: BatchEditMode
  operation: Readonly<BatchEditOperation>
  recipeIds: readonly string[]
  outputSpecIds: readonly string[]
  itemIds: readonly string[]
  availableRecipeIds: readonly string[]
  availableOutputSpecIds: readonly string[]
  availableItemIds: readonly string[]
  items: readonly Readonly<BatchEditItemContext>[]
  budgetRemainingMinorUnits: number
  createdByClientId: string
  createdAt: string
}

export interface CreateBatchEditCommandInput {
  id: string
  preflight: Readonly<BatchEditPreflightRun>
  currentStates: readonly Readonly<BatchEditItemState>[]
  createdByClientId: string
  createdAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function integer(
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
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function mode(value: unknown, field = 'mode'): BatchEditMode {
  assertDomain(
    value === 'all-or-nothing' || value === 'skip-failures',
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function operation(
  value: Readonly<BatchEditOperation>,
): Readonly<BatchEditOperation> {
  assertDomain(
    value &&
      BATCH_EDIT_OPERATION_TYPES.includes(value.type) &&
      typeof value.valueRef === 'string' &&
      ID.test(value.valueRef.trim()),
    'INVALID_ARGUMENT',
    'Batch edit operation is invalid',
  )
  return Object.freeze({
    type: value.type,
    valueRef: value.valueRef.trim(),
  })
}

function tokens(
  values: readonly string[],
  field: string,
  maximum = 100,
): readonly string[] {
  assertDomain(
    Array.isArray(values) &&
      values.length >= 1 &&
      values.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must contain one to ${maximum} IDs`,
  )
  const normalized = values.map((value, index) =>
    identity(value, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicate IDs`,
  )
  return Object.freeze(normalized.toSorted())
}

function optionalIdentity(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined ? undefined : identity(value, field)
}

function directives(
  value: Readonly<BatchEditItemDirectives> | undefined,
): Readonly<BatchEditItemDirectives> {
  const normalized = {
    ...(value?.ctaRef
      ? { ctaRef: identity(value.ctaRef, 'directives.ctaRef') }
      : {}),
    ...(value?.subtitleStyleId
      ? {
          subtitleStyleId: identity(
            value.subtitleStyleId,
            'directives.subtitleStyleId',
          ),
        }
      : {}),
    ...(value?.brandKitSnapshotId
      ? {
          brandKitSnapshotId: identity(
            value.brandKitSnapshotId,
            'directives.brandKitSnapshotId',
          ),
        }
      : {}),
  }
  return Object.freeze(normalized)
}

function protectedOperations(
  values: readonly BatchEditOperationType[] | undefined,
): readonly BatchEditOperationType[] {
  const normalized = [...(values ?? [])]
  assertDomain(
    normalized.length <= BATCH_EDIT_OPERATION_TYPES.length &&
      normalized.every((value) =>
        BATCH_EDIT_OPERATION_TYPES.includes(value)) &&
      new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    'protectedOperations is invalid',
  )
  return Object.freeze(normalized.toSorted())
}

function policyBody(value: Omit<BatchEditPolicy, 'policyHash'>) {
  return value
}

export function createBatchEditPolicy(
  input: Readonly<CreateBatchEditPolicyInput>,
): Readonly<BatchEditPolicy> {
  const body = Object.freeze({
    schemaVersion: BATCH_EDIT_POLICY_SCHEMA_VERSION,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    revision: integer(input.revision ?? 1, 'revision', 1, 1_000_000),
    defaultMode: mode(input.defaultMode ?? 'all-or-nothing'),
    maxItemCount: integer(
      input.maxItemCount ?? 100,
      'maxItemCount',
      1,
      1_000,
    ),
    diffSampleSize: integer(
      input.diffSampleSize ?? 5,
      'diffSampleSize',
      1,
      25,
    ),
    replaceCtaCostMinorUnits: integer(
      input.replaceCtaCostMinorUnits ?? 125,
      'replaceCtaCostMinorUnits',
      0,
      1_000_000,
    ),
    subtitleStyleCostMinorUnits: integer(
      input.subtitleStyleCostMinorUnits ?? 25,
      'subtitleStyleCostMinorUnits',
      0,
      1_000_000,
    ),
    brandKitCostMinorUnits: integer(
      input.brandKitCostMinorUnits ?? 75,
      'brandKitCostMinorUnits',
      0,
      1_000_000,
    ),
    confirmationTtlSeconds: integer(
      input.confirmationTtlSeconds ?? 900,
      'confirmationTtlSeconds',
      60,
      86_400,
    ),
    updatedByClientId: identity(
      input.updatedByClientId,
      'updatedByClientId',
    ),
    updatedAt: instant(input.updatedAt, 'updatedAt'),
  })
  assertDomain(
    body.diffSampleSize <= body.maxItemCount,
    'INVALID_ARGUMENT',
    'diffSampleSize cannot exceed maxItemCount',
  )
  return Object.freeze({
    ...body,
    policyHash: calculateCanonicalHash(policyBody(body)),
  })
}

export function hydrateBatchEditPolicy(
  value: Readonly<BatchEditPolicy>,
): Readonly<BatchEditPolicy> {
  const hydrated = createBatchEditPolicy(value)
  assertDomain(
    value.schemaVersion === BATCH_EDIT_POLICY_SCHEMA_VERSION &&
      value.policyHash === hydrated.policyHash &&
      stableSerialize(value) === stableSerialize(hydrated),
    'PERSISTENCE_CONFLICT',
    'Stored batch edit policy is inconsistent',
  )
  return hydrated
}

function itemStateBody(
  value: Omit<BatchEditItemState, 'stateHash'>,
) {
  return value
}

export function createBatchEditItemState(
  input: Readonly<CreateBatchEditItemStateInput>,
): Readonly<BatchEditItemState> {
  const previousStateHash = input.previousStateHash
    ? hash(input.previousStateHash, 'previousStateHash')
    : undefined
  const sourceCommandId = optionalIdentity(
    input.sourceCommandId,
    'sourceCommandId',
  )
  const revision = integer(
    input.revision ?? 1,
    'state.revision',
    1,
    1_000_000,
  )
  assertDomain(
    (revision === 1 && !previousStateHash && !sourceCommandId) ||
      (revision > 1 && Boolean(previousStateHash) && Boolean(sourceCommandId)),
    'INVALID_ARGUMENT',
    'Batch edit item state lineage is invalid',
  )
  const body = Object.freeze({
    schemaVersion: BATCH_EDIT_ITEM_STATE_SCHEMA_VERSION,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    batchId: identity(input.batchId, 'batchId'),
    itemId: identity(input.itemId, 'itemId'),
    revision,
    directives: directives(input.directives),
    protectedOperations: protectedOperations(
      input.protectedOperations,
    ),
    ...(previousStateHash ? { previousStateHash } : {}),
    ...(sourceCommandId ? { sourceCommandId } : {}),
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
  return Object.freeze({
    ...body,
    stateHash: calculateCanonicalHash(itemStateBody(body)),
  })
}

export function hydrateBatchEditItemState(
  value: Readonly<BatchEditItemState>,
): Readonly<BatchEditItemState> {
  const hydrated = createBatchEditItemState(value)
  assertDomain(
    value.schemaVersion === BATCH_EDIT_ITEM_STATE_SCHEMA_VERSION &&
      value.stateHash === hydrated.stateHash &&
      stableSerialize(value) === stableSerialize(hydrated),
    'PERSISTENCE_CONFLICT',
    `Stored batch edit item state ${value.itemId} is inconsistent`,
  )
  return hydrated
}

function currentValue(
  state: Readonly<BatchEditItemState>,
  type: BatchEditOperationType,
): string | undefined {
  if (type === 'replace-cta') return state.directives.ctaRef
  if (type === 'subtitle-style') {
    return state.directives.subtitleStyleId
  }
  return state.directives.brandKitSnapshotId
}

function nextDirectives(
  state: Readonly<BatchEditItemState>,
  edit: Readonly<BatchEditOperation>,
): Readonly<BatchEditItemDirectives> {
  if (edit.type === 'replace-cta') {
    return directives({
      ...state.directives,
      ctaRef: edit.valueRef,
    })
  }
  if (edit.type === 'subtitle-style') {
    return directives({
      ...state.directives,
      subtitleStyleId: edit.valueRef,
    })
  }
  return directives({
    ...state.directives,
    brandKitSnapshotId: edit.valueRef,
  })
}

function invalidationSteps(
  type: BatchEditOperationType,
): readonly ProductionBatchStep[] {
  if (type === 'replace-cta') return PRODUCTION_BATCH_STEPS
  if (type === 'subtitle-style') {
    return Object.freeze(['rendering', 'reviewing'])
  }
  return Object.freeze(['materializing', 'rendering', 'reviewing'])
}

function unitCost(
  policy: Readonly<BatchEditPolicy>,
  type: BatchEditOperationType,
): number {
  if (type === 'replace-cta') {
    return policy.replaceCtaCostMinorUnits
  }
  if (type === 'subtitle-style') {
    return policy.subtitleStyleCostMinorUnits
  }
  return policy.brandKitCostMinorUnits
}

function scopeBody(value: Omit<BatchEditScope, 'scopeHash'>) {
  return value
}

function impactBody(
  value: Omit<BatchEditItemImpact, 'impactHash'>,
) {
  return value
}

function diffBody(
  value: Omit<BatchEditSampleDiff, 'diffHash'>,
) {
  return value
}

function preflightBody(
  value: Omit<BatchEditPreflightRun, 'preflightHash'>,
) {
  return value
}

export function createBatchEditPreflight(
  input: Readonly<CreateBatchEditPreflightInput>,
): Readonly<BatchEditPreflightRun> {
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const batchId = identity(input.batchId, 'batchId')
  const projectId = identity(input.projectId, 'projectId')
  const policy = hydrateBatchEditPolicy(input.policy)
  assertDomain(
    policy.workspaceId === workspaceId,
    'PRECONDITION_REQUIRED',
    'Batch edit policy does not belong to the workspace',
  )
  const edit = operation(input.operation)
  const resolvedMode = mode(input.mode ?? policy.defaultMode)
  const selectedRecipeIds = tokens(
    input.recipeIds,
    'recipeIds',
    policy.maxItemCount,
  )
  const selectedOutputSpecIds = tokens(
    input.outputSpecIds,
    'outputSpecIds',
    policy.maxItemCount,
  )
  const selectedItemIds = tokens(
    input.itemIds,
    'itemIds',
    policy.maxItemCount,
  )
  const availableRecipeIds = tokens(
    input.availableRecipeIds,
    'availableRecipeIds',
    1_000,
  )
  const availableOutputSpecIds = tokens(
    input.availableOutputSpecIds,
    'availableOutputSpecIds',
    1_000,
  )
  const availableItemIds = tokens(
    input.availableItemIds,
    'availableItemIds',
    1_000,
  )
  assertDomain(
    selectedRecipeIds.every((id) => availableRecipeIds.includes(id)) &&
      selectedOutputSpecIds.every((id) =>
        availableOutputSpecIds.includes(id)) &&
      selectedItemIds.every((id) => availableItemIds.includes(id)),
    'INVALID_ARGUMENT',
    'Batch edit scope references unavailable recipes, formats or targets',
  )
  assertDomain(
    input.items.length === selectedItemIds.length,
    'INVALID_ARGUMENT',
    'Batch edit target contexts do not match explicit item scope',
  )
  const contexts = input.items.map((item) => {
    const state = hydrateBatchEditItemState(item.state)
    const itemId = identity(item.itemId, 'items.itemId')
    assertDomain(
      itemId === state.itemId &&
        state.workspaceId === workspaceId &&
        state.batchId === batchId,
      'PRECONDITION_REQUIRED',
      `Batch edit state does not belong to target ${itemId}`,
    )
    const locale = typeof item.locale === 'string'
      ? item.locale.trim()
      : ''
    assertDomain(
      LOCALE.test(locale),
      'INVALID_ARGUMENT',
      `Batch edit target ${itemId} locale is invalid`,
    )
    return Object.freeze({
      itemId,
      recipeId: identity(item.recipeId, 'items.recipeId'),
      variantId: identity(item.variantId, 'items.variantId'),
      outputSpecId: identity(
        item.outputSpecId,
        'items.outputSpecId',
      ),
      locale,
      state,
    })
  }).toSorted((left, right) => left.itemId.localeCompare(right.itemId))
  assertDomain(
    contexts.map((item) => item.itemId).join('\u0000') ===
      selectedItemIds.join('\u0000') &&
      contexts.every((item) =>
        selectedRecipeIds.includes(item.recipeId) &&
        selectedOutputSpecIds.includes(item.outputSpecId)) &&
      selectedRecipeIds.every((recipeId) =>
        contexts.some((item) => item.recipeId === recipeId)) &&
      selectedOutputSpecIds.every((outputSpecId) =>
        contexts.some((item) => item.outputSpecId === outputSpecId)),
    'INVALID_ARGUMENT',
    'Batch edit scope must explicitly and exactly match its targets',
  )
  const batchRevision = integer(
    input.batchRevision,
    'batchRevision',
    1,
    1_000_000,
  )
  const batchDefinitionHash = hash(
    input.batchDefinitionHash,
    'batchDefinitionHash',
  )
  const scopeContent = Object.freeze({
    recipeIds: selectedRecipeIds,
    outputSpecIds: selectedOutputSpecIds,
    itemIds: selectedItemIds,
  })
  const scope = Object.freeze({
    ...scopeContent,
    scopeHash: calculateCanonicalHash({
      ...scopeBody(scopeContent),
      batchRevision,
      batchDefinitionHash,
      stateHashes: contexts.map((item) => item.state.stateHash),
      operation: edit,
      mode: resolvedMode,
    }),
  })
  const itemCost = unitCost(policy, edit.type)
  const impacts = Object.freeze(contexts.map((item) => {
    const beforeValueRef = currentValue(item.state, edit.type)
    const protectedConflict =
      item.state.protectedOperations.includes(edit.type)
    const unchanged = beforeValueRef === edit.valueRef
    const disposition: BatchEditItemDisposition =
      protectedConflict
        ? 'protected'
        : unchanged
          ? 'unchanged'
          : 'applicable'
    const conflictCodes = Object.freeze(
      protectedConflict ? ['PROTECTED_TARGET'] : [],
    )
    const steps = disposition === 'applicable'
      ? invalidationSteps(edit.type)
      : Object.freeze([] as ProductionBatchStep[])
    const targetRef = `${item.itemId}:${edit.type}`
    const content = Object.freeze({
      itemId: item.itemId,
      recipeId: item.recipeId,
      variantId: item.variantId,
      outputSpecId: item.outputSpecId,
      locale: item.locale,
      targetRef,
      disposition,
      ...(beforeValueRef ? { beforeValueRef } : {}),
      afterValueRef: edit.valueRef,
      beforeStateRevision: item.state.revision,
      beforeStateHash: item.state.stateHash,
      protectedConflict,
      conflictCodes,
      invalidatedSteps: steps,
      invalidatedTargetRefs: Object.freeze(
        steps.map((step) => `${targetRef}:${step}`),
      ),
      estimatedCostMinorUnits:
        disposition === 'applicable' ? itemCost : 0,
    })
    return Object.freeze({
      ...content,
      impactHash: calculateCanonicalHash(impactBody(content)),
    })
  }))
  const applicableItemCount = impacts.filter((item) =>
    item.disposition === 'applicable').length
  const protectedConflictCount = impacts.filter((item) =>
    item.protectedConflict).length
  const unchangedItemCount = impacts.filter((item) =>
    item.disposition === 'unchanged').length
  const estimatedCostMinorUnits = impacts.reduce(
    (total, item) => total + item.estimatedCostMinorUnits,
    0,
  )
  const budgetRemainingMinorUnits = integer(
    input.budgetRemainingMinorUnits,
    'budgetRemainingMinorUnits',
    0,
    100_000_000,
  )
  const budgetExceeded =
    estimatedCostMinorUnits > budgetRemainingMinorUnits
  const status: BatchEditPreflightStatus =
    budgetExceeded ||
    (
      resolvedMode === 'all-or-nothing' &&
      protectedConflictCount > 0
    ) ||
    (
      resolvedMode === 'skip-failures' &&
      applicableItemCount === 0 &&
      protectedConflictCount > 0
    )
      ? 'blocked'
      : applicableItemCount === 0
        ? 'no-change'
        : protectedConflictCount > 0
          ? 'partial-ready'
          : 'ready'
  const sampleDiff = Object.freeze(
    impacts.slice(0, policy.diffSampleSize).map((item) => {
      const content = Object.freeze({
        itemId: item.itemId,
        recipeId: item.recipeId,
        outputSpecId: item.outputSpecId,
        targetRef: item.targetRef,
        before: Object.freeze(
          item.beforeValueRef
            ? {
                mode: 'override' as const,
                valueRef: item.beforeValueRef,
              }
            : { mode: 'inherit' as const },
        ),
        after: Object.freeze({
          mode: 'override' as const,
          valueRef: item.afterValueRef,
        }),
        disposition: item.disposition,
        conflictCodes: item.conflictCodes,
      })
      return Object.freeze({
        ...content,
        diffHash: calculateCanonicalHash(diffBody(content)),
      })
    }),
  )
  const partialRecipeScope =
    selectedRecipeIds.length < availableRecipeIds.length
  const partialFormatScope =
    selectedOutputSpecIds.length < availableOutputSpecIds.length
  const partialTargetScope =
    selectedItemIds.length < availableItemIds.length
  const warningCodes = Object.freeze([
    ...(protectedConflictCount > 0
      ? ['PROTECTED_TARGETS_PRESENT']
      : []),
    ...(budgetExceeded ? ['BUDGET_EXCEEDED'] : []),
    ...(partialRecipeScope ? ['PARTIAL_RECIPE_SCOPE'] : []),
    ...(partialFormatScope
      ? ['EXPERIMENT_FORMAT_SCOPE_INCOMPLETE']
      : []),
    ...(partialTargetScope ? ['PARTIAL_TARGET_SCOPE'] : []),
    ...(status === 'no-change' ? ['NO_EFFECTIVE_CHANGE'] : []),
  ].toSorted())
  const createdAt = instant(input.createdAt, 'createdAt')
  const confirmationExpiresAt =
    status === 'ready' || status === 'partial-ready'
      ? new Date(
          Date.parse(createdAt) +
          policy.confirmationTtlSeconds * 1_000,
        ).toISOString()
      : undefined
  const costFingerprint = calculateCanonicalHash({
    version: 'batch-edit-cost/v1',
    policyHash: policy.policyHash,
    budgetRemainingMinorUnits,
    estimatedCostMinorUnits,
    applicableItemCount,
    invalidationCount: impacts.reduce(
      (total, item) => total + item.invalidatedSteps.length,
      0,
    ),
  })
  const body = Object.freeze({
    schemaVersion: BATCH_EDIT_PREFLIGHT_SCHEMA_VERSION,
    impactVersion: BATCH_EDIT_IMPACT_VERSION,
    id: identity(input.id, 'id'),
    workspaceId,
    projectId,
    batchId,
    batchRevision,
    batchDefinitionHash,
    policy,
    mode: resolvedMode,
    operation: edit,
    scope,
    status,
    budgetRemainingMinorUnits,
    affectedItemCount: impacts.length,
    applicableItemCount,
    protectedConflictCount,
    unchangedItemCount,
    invalidationCount: impacts.reduce(
      (total, item) => total + item.invalidatedSteps.length,
      0,
    ),
    estimatedCostMinorUnits,
    budgetExceeded,
    impacts,
    sampleDiff,
    warningCodes,
    ...(confirmationExpiresAt ? { confirmationExpiresAt } : {}),
    costFingerprint,
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt,
  })
  return Object.freeze({
    ...body,
    preflightHash: calculateCanonicalHash(preflightBody(body)),
  })
}

export function hydrateBatchEditPreflight(
  value: Readonly<BatchEditPreflightRun>,
): Readonly<BatchEditPreflightRun> {
  const { preflightHash, ...body } = value
  assertDomain(
    value.schemaVersion === BATCH_EDIT_PREFLIGHT_SCHEMA_VERSION &&
      value.impactVersion === BATCH_EDIT_IMPACT_VERSION &&
      HASH.test(value.preflightHash) &&
      value.scope.scopeHash === calculateCanonicalHash({
        ...scopeBody({
          recipeIds: value.scope.recipeIds,
          outputSpecIds: value.scope.outputSpecIds,
          itemIds: value.scope.itemIds,
        }),
        batchRevision: value.batchRevision,
        batchDefinitionHash: value.batchDefinitionHash,
        stateHashes: value.impacts.map((item) =>
          item.beforeStateHash),
        operation: value.operation,
        mode: value.mode,
      }) &&
      value.impacts.length === value.affectedItemCount &&
      value.impacts.filter((item) =>
        item.disposition === 'applicable').length ===
        value.applicableItemCount &&
      value.impacts.filter((item) =>
        item.protectedConflict).length ===
        value.protectedConflictCount &&
      value.impacts.filter((item) =>
        item.disposition === 'unchanged').length ===
        value.unchangedItemCount &&
      value.impacts.every((item) =>
        item.impactHash === calculateCanonicalHash(
          impactBody({
            itemId: item.itemId,
            recipeId: item.recipeId,
            variantId: item.variantId,
            outputSpecId: item.outputSpecId,
            locale: item.locale,
            targetRef: item.targetRef,
            disposition: item.disposition,
            ...(item.beforeValueRef
              ? { beforeValueRef: item.beforeValueRef }
              : {}),
            afterValueRef: item.afterValueRef,
            beforeStateRevision: item.beforeStateRevision,
            beforeStateHash: item.beforeStateHash,
            protectedConflict: item.protectedConflict,
            conflictCodes: item.conflictCodes,
            invalidatedSteps: item.invalidatedSteps,
            invalidatedTargetRefs: item.invalidatedTargetRefs,
            estimatedCostMinorUnits:
              item.estimatedCostMinorUnits,
          }),
        )) &&
      calculateCanonicalHash(preflightBody(body)) ===
        preflightHash,
    'PERSISTENCE_CONFLICT',
    `Stored batch edit preflight ${value.id} is inconsistent`,
  )
  hydrateBatchEditPolicy(value.policy)
  return Object.freeze(value)
}

export function createNextBatchEditItemState(input: {
  current: Readonly<BatchEditItemState>
  operation: Readonly<BatchEditOperation>
  commandId: string
  createdByClientId: string
  createdAt: string
}): Readonly<BatchEditItemState> {
  const current = hydrateBatchEditItemState(input.current)
  const edit = operation(input.operation)
  assertDomain(
    !current.protectedOperations.includes(edit.type),
    'PRECONDITION_REQUIRED',
    `Batch edit target ${current.itemId} is protected`,
  )
  assertDomain(
    currentValue(current, edit.type) !== edit.valueRef,
    'VERSION_CONFLICT',
    `Batch edit target ${current.itemId} already has the requested value`,
  )
  return createBatchEditItemState({
    workspaceId: current.workspaceId,
    batchId: current.batchId,
    itemId: current.itemId,
    revision: current.revision + 1,
    directives: nextDirectives(current, edit),
    protectedOperations: current.protectedOperations,
    previousStateHash: current.stateHash,
    sourceCommandId: input.commandId,
    createdByClientId: input.createdByClientId,
    createdAt: input.createdAt,
  })
}

function resultBody(
  value: Omit<BatchEditItemResult, 'resultHash'>,
) {
  return value
}

function commandBody(
  value: Omit<BatchEditCommand, 'commandHash'>,
) {
  return value
}

export function createBatchEditCommand(
  input: Readonly<CreateBatchEditCommandInput>,
): Readonly<BatchEditCommand> {
  const preflight = hydrateBatchEditPreflight(input.preflight)
  assertDomain(
    preflight.status === 'ready' ||
      preflight.status === 'partial-ready',
    'PRECONDITION_REQUIRED',
    'Batch edit preflight is not committable',
  )
  const commandId = identity(input.id, 'command.id')
  const clientId = identity(
    input.createdByClientId,
    'createdByClientId',
  )
  assertDomain(
    clientId === preflight.createdByClientId,
    'AUTH_INVALID',
    'Batch edit commit actor differs from the preflight actor',
  )
  const createdAt = instant(input.createdAt, 'createdAt')
  const states = new Map(
    input.currentStates.map((state) => {
      const hydrated = hydrateBatchEditItemState(state)
      return [hydrated.itemId, hydrated] as const
    }),
  )
  assertDomain(
    states.size === preflight.affectedItemCount,
    'VERSION_CONFLICT',
    'Batch edit target state set changed after preflight',
  )
  const newStates: BatchEditItemState[] = []
  const resultItems = Object.freeze(preflight.impacts.map((impact) => {
    const current = states.get(impact.itemId)
    assertDomain(
      current &&
        current.stateHash === impact.beforeStateHash &&
        current.revision === impact.beforeStateRevision,
      'VERSION_CONFLICT',
      `Batch edit target ${impact.itemId} changed after preflight`,
    )
    let status: BatchEditItemResultStatus
    let next: Readonly<BatchEditItemState> | undefined
    if (impact.disposition === 'applicable') {
      next = createNextBatchEditItemState({
        current,
        operation: preflight.operation,
        commandId,
        createdByClientId: clientId,
        createdAt,
      })
      newStates.push(next)
      status = 'applied'
    } else if (impact.disposition === 'protected') {
      status = 'skipped'
    } else {
      status = 'unchanged'
    }
    const content = Object.freeze({
      itemId: impact.itemId,
      recipeId: impact.recipeId,
      variantId: impact.variantId,
      outputSpecId: impact.outputSpecId,
      targetRef: impact.targetRef,
      status,
      beforeStateRevision: current.revision,
      beforeStateHash: current.stateHash,
      ...(next
        ? {
            afterStateRevision: next.revision,
            afterStateHash: next.stateHash,
          }
        : {}),
      conflictCodes: impact.conflictCodes,
      invalidatedSteps:
        status === 'applied'
          ? impact.invalidatedSteps
          : Object.freeze([] as ProductionBatchStep[]),
      invalidatedTargetRefs:
        status === 'applied'
          ? impact.invalidatedTargetRefs
          : Object.freeze([] as string[]),
      costMinorUnits:
        status === 'applied'
          ? impact.estimatedCostMinorUnits
          : 0,
    })
    return Object.freeze({
      ...content,
      resultHash: calculateCanonicalHash(resultBody(content)),
    })
  }))
  const appliedItemCount = resultItems.filter((item) =>
    item.status === 'applied').length
  const skippedItemCount = resultItems.filter((item) =>
    item.status === 'skipped').length
  const unchangedItemCount = resultItems.filter((item) =>
    item.status === 'unchanged').length
  assertDomain(
    appliedItemCount === preflight.applicableItemCount &&
      (
        preflight.mode === 'skip-failures' ||
        skippedItemCount === 0
      ),
    'PERSISTENCE_CONFLICT',
    'Batch edit command result differs from its preflight',
  )
  const body = Object.freeze({
    schemaVersion: BATCH_EDIT_COMMAND_SCHEMA_VERSION,
    id: commandId,
    workspaceId: preflight.workspaceId,
    projectId: preflight.projectId,
    batchId: preflight.batchId,
    preflightId: preflight.id,
    preflightHash: preflight.preflightHash,
    batchRevision: preflight.batchRevision,
    batchDefinitionHash: preflight.batchDefinitionHash,
    policyHash: preflight.policy.policyHash,
    mode: preflight.mode,
    operation: preflight.operation,
    scope: preflight.scope,
    status: skippedItemCount > 0 ? 'partial' as const : 'committed' as const,
    resultItems,
    newStates: Object.freeze(newStates),
    affectedItemCount: resultItems.length,
    appliedItemCount,
    skippedItemCount,
    unchangedItemCount,
    invalidationCount: resultItems.reduce(
      (total, item) => total + item.invalidatedSteps.length,
      0,
    ),
    costMinorUnits: resultItems.reduce(
      (total, item) => total + item.costMinorUnits,
      0,
    ),
    createdByClientId: clientId,
    createdAt,
  })
  return Object.freeze({
    ...body,
    commandHash: calculateCanonicalHash(commandBody(body)),
  })
}

export function hydrateBatchEditCommand(
  value: Readonly<BatchEditCommand>,
): Readonly<BatchEditCommand> {
  const { commandHash, ...body } = value
  assertDomain(
    value.schemaVersion === BATCH_EDIT_COMMAND_SCHEMA_VERSION &&
      HASH.test(value.commandHash) &&
      value.resultItems.length === value.affectedItemCount &&
      value.resultItems.filter((item) =>
        item.status === 'applied').length ===
        value.appliedItemCount &&
      value.resultItems.filter((item) =>
        item.status === 'skipped').length ===
        value.skippedItemCount &&
      value.resultItems.filter((item) =>
        item.status === 'unchanged').length ===
        value.unchangedItemCount &&
      value.newStates.length === value.appliedItemCount &&
      value.newStates.every((state) =>
        hydrateBatchEditItemState(state).sourceCommandId === value.id) &&
      value.resultItems.every((item) =>
        item.resultHash === calculateCanonicalHash(
          resultBody({
            itemId: item.itemId,
            recipeId: item.recipeId,
            variantId: item.variantId,
            outputSpecId: item.outputSpecId,
            targetRef: item.targetRef,
            status: item.status,
            beforeStateRevision: item.beforeStateRevision,
            beforeStateHash: item.beforeStateHash,
            ...(item.afterStateRevision !== undefined
              ? { afterStateRevision: item.afterStateRevision }
              : {}),
            ...(item.afterStateHash
              ? { afterStateHash: item.afterStateHash }
              : {}),
            conflictCodes: item.conflictCodes,
            invalidatedSteps: item.invalidatedSteps,
            invalidatedTargetRefs: item.invalidatedTargetRefs,
            costMinorUnits: item.costMinorUnits,
          }),
        )) &&
      calculateCanonicalHash(commandBody(body)) === commandHash,
    'PERSISTENCE_CONFLICT',
    `Stored batch edit command ${value.id} is inconsistent`,
  )
  return Object.freeze(value)
}
