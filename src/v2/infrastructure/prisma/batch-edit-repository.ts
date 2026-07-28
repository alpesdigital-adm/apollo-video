import {
  Prisma,
  type PrismaClient,
  type V2BatchEditCommand,
  type V2BatchEditCommandItem,
  type V2BatchEditInvalidation,
  type V2BatchEditItemStateVersion,
  type V2BatchEditPolicy,
  type V2BatchEditPreflightRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  BatchEditCommandPage,
  BatchEditCommandRecord,
  BatchEditCommandReplay,
  BatchEditPreflightPage,
  BatchEditPreflightRecord,
  BatchEditPreflightReplay,
  BatchEditRepository,
} from '../../application/ports/batch-edit-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import {
  createBatchEditItemState,
  hydrateBatchEditCommand,
  hydrateBatchEditItemState,
  hydrateBatchEditPolicy,
  hydrateBatchEditPreflight,
  type BatchEditCommand,
  type BatchEditItemState,
  type BatchEditPolicy,
  type BatchEditPreflightRun,
} from '../../domain/batch-edit.ts'
import { DomainError } from '../../domain/errors.ts'
import type {
  ProductionBatchRecipe,
  ProductionBatchVariant,
} from '../../domain/production-batch.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type CommandRow = V2BatchEditCommand & {
  items: Array<V2BatchEditCommandItem & {
    invalidations: V2BatchEditInvalidation[]
  }>
  stateVersions: V2BatchEditItemStateVersion[]
}

const commandInclude = {
  items: { include: { invalidations: true } },
  stateVersions: true,
} satisfies Prisma.V2BatchEditCommandInclude

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
}

function canonicalJson<T>(
  value: string,
  field: string,
): Readonly<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
  if (stableSerialize(parsed) !== value) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is not canonical JSON`,
    )
  }
  return Object.freeze(parsed as T)
}

export function hydrateBatchEditPolicyRow(
  row: V2BatchEditPolicy,
): Readonly<BatchEditPolicy> {
  const policy = hydrateBatchEditPolicy(
    canonicalJson<BatchEditPolicy>(
      row.policyJson,
      'batch edit policy',
    ),
  )
  if (
    policy.workspaceId !== row.workspaceId ||
    policy.schemaVersion !== row.schemaVersion ||
    policy.revision !== row.revision ||
    policy.defaultMode !== row.defaultMode ||
    policy.maxItemCount !== row.maxItemCount ||
    policy.diffSampleSize !== row.diffSampleSize ||
    policy.replaceCtaCostMinorUnits !==
      row.replaceCtaCostMinorUnits ||
    policy.subtitleStyleCostMinorUnits !==
      row.subtitleStyleCostMinorUnits ||
    policy.brandKitCostMinorUnits !== row.brandKitCostMinorUnits ||
    policy.confirmationTtlSeconds !== row.confirmationTtlSeconds ||
    policy.policyHash !== row.policyHash ||
    policy.updatedByClientId !== row.updatedByClientId ||
    policy.updatedAt !== row.updatedAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored batch edit policy revision ${row.revision} is inconsistent`,
    )
  }
  return policy
}

export function hydrateBatchEditItemStateRow(
  row: V2BatchEditItemStateVersion,
): Readonly<BatchEditItemState> {
  const state = hydrateBatchEditItemState(
    canonicalJson<BatchEditItemState>(
      row.stateJson,
      'batch edit item state',
    ),
  )
  if (
    state.workspaceId !== row.workspaceId ||
    state.batchId !== row.batchId ||
    state.itemId !== row.itemId ||
    state.revision !== row.revision ||
    state.schemaVersion !== row.schemaVersion ||
    stableSerialize(state.directives) !== row.directivesJson ||
    stableSerialize(state.protectedOperations) !==
      row.protectedOperationsJson ||
    state.stateHash !== row.stateHash ||
    (state.previousStateHash ?? null) !== row.previousStateHash ||
    (state.sourceCommandId ?? null) !== row.sourceCommandId ||
    state.createdByClientId !== row.createdByClientId ||
    state.createdAt !== row.createdAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored batch edit item state ${row.itemId}/${row.revision} is inconsistent`,
    )
  }
  return state
}

export function hydrateBatchEditPreflightRow(
  row: V2BatchEditPreflightRun,
): Readonly<BatchEditPreflightRun> {
  const run = hydrateBatchEditPreflight(
    canonicalJson<BatchEditPreflightRun>(
      row.resultJson,
      'batch edit preflight',
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.schemaVersion !== row.schemaVersion ||
    run.impactVersion !== row.impactVersion ||
    run.status !== row.status ||
    run.mode !== row.mode ||
    run.operation.type !== row.operationType ||
    run.operation.valueRef !== row.operationValueRef ||
    run.policy.policyHash !== row.policyHash ||
    run.batchRevision !== row.batchRevision ||
    run.batchDefinitionHash !== row.batchDefinitionHash ||
    run.scope.scopeHash !== row.scopeHash ||
    run.budgetRemainingMinorUnits !==
      row.budgetRemainingMinorUnits ||
    run.affectedItemCount !== row.affectedItemCount ||
    run.applicableItemCount !== row.applicableItemCount ||
    run.protectedConflictCount !== row.protectedConflictCount ||
    run.unchangedItemCount !== row.unchangedItemCount ||
    run.invalidationCount !== row.invalidationCount ||
    run.estimatedCostMinorUnits !== row.estimatedCostMinorUnits ||
    run.budgetExceeded !== row.budgetExceeded ||
    (run.confirmationExpiresAt ?? null) !==
      (row.confirmationExpiresAt?.toISOString() ?? null) ||
    run.costFingerprint !== row.costFingerprint ||
    run.preflightHash !== row.preflightHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored batch edit preflight ${row.id} has inconsistent projections`,
    )
  }
  return run
}

export function hydrateBatchEditCommandRow(
  row: CommandRow,
): Readonly<BatchEditCommand> {
  const command = hydrateBatchEditCommand(
    canonicalJson<BatchEditCommand>(
      row.resultJson,
      'batch edit command',
    ),
  )
  const stateRows = new Map(
    row.stateVersions.map((state) => [
      `${state.itemId}:${state.revision}`,
      hydrateBatchEditItemStateRow(state),
    ]),
  )
  const resultRows = new Map(
    row.items.map((item) => [`${item.itemId}`, item]),
  )
  if (
    command.id !== row.id ||
    command.workspaceId !== row.workspaceId ||
    command.projectId !== row.projectId ||
    command.batchId !== row.batchId ||
    command.preflightId !== row.preflightId ||
    command.preflightHash !== row.preflightHash ||
    command.schemaVersion !== row.schemaVersion ||
    command.status !== row.status ||
    command.mode !== row.mode ||
    command.operation.type !== row.operationType ||
    command.operation.valueRef !== row.operationValueRef ||
    command.batchRevision !== row.batchRevision ||
    command.batchDefinitionHash !== row.batchDefinitionHash ||
    command.policyHash !== row.policyHash ||
    command.scope.scopeHash !== row.scopeHash ||
    command.affectedItemCount !== row.affectedItemCount ||
    command.appliedItemCount !== row.appliedItemCount ||
    command.skippedItemCount !== row.skippedItemCount ||
    command.unchangedItemCount !== row.unchangedItemCount ||
    command.invalidationCount !== row.invalidationCount ||
    command.costMinorUnits !== row.costMinorUnits ||
    command.commandHash !== row.commandHash ||
    command.createdByClientId !== row.createdByClientId ||
    command.createdAt !== row.createdAt.toISOString() ||
    stateRows.size !== command.newStates.length ||
    resultRows.size !== command.resultItems.length ||
    !command.newStates.every((state) =>
      stateRows.get(`${state.itemId}:${state.revision}`)?.stateHash ===
        state.stateHash) ||
    !command.resultItems.every((result) => {
      const persisted = resultRows.get(result.itemId)
      const invalidations = new Map(
        persisted?.invalidations.map((entry) => [
          entry.sequence,
          entry,
        ]) ?? [],
      )
      return persisted &&
        persisted.status === result.status &&
        persisted.targetRef === result.targetRef &&
        persisted.beforeStateRevision === result.beforeStateRevision &&
        persisted.beforeStateHash === result.beforeStateHash &&
        persisted.afterStateRevision ===
          (result.afterStateRevision ?? null) &&
        persisted.afterStateHash === (result.afterStateHash ?? null) &&
        persisted.costMinorUnits === result.costMinorUnits &&
        persisted.resultHash === result.resultHash &&
        stableSerialize(result) === persisted.resultJson &&
        persisted.invalidations.length ===
          result.invalidatedSteps.length &&
        invalidations.size === result.invalidatedSteps.length &&
        result.invalidatedSteps.every((step, sequence) => {
          const actual = invalidations.get(sequence)
          const expected = invalidationData(
            command,
            result,
            step,
            sequence,
          )
          return actual &&
            actual.workspaceId === expected.workspaceId &&
            actual.batchId === expected.batchId &&
            actual.commandId === expected.commandId &&
            actual.itemId === expected.itemId &&
            actual.step === expected.step &&
            actual.sequence === expected.sequence &&
            actual.targetRef === expected.targetRef &&
            actual.invalidationHash ===
              expected.invalidationHash &&
            actual.createdAt.getTime() ===
              expected.createdAt.getTime()
        })
    })
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored batch edit command ${row.id} has inconsistent projections`,
    )
  }
  return command
}

function policyData(policy: Readonly<BatchEditPolicy>) {
  return {
    workspaceId: policy.workspaceId,
    schemaVersion: policy.schemaVersion,
    revision: policy.revision,
    defaultMode: policy.defaultMode,
    maxItemCount: policy.maxItemCount,
    diffSampleSize: policy.diffSampleSize,
    replaceCtaCostMinorUnits: policy.replaceCtaCostMinorUnits,
    subtitleStyleCostMinorUnits:
      policy.subtitleStyleCostMinorUnits,
    brandKitCostMinorUnits: policy.brandKitCostMinorUnits,
    confirmationTtlSeconds: policy.confirmationTtlSeconds,
    policyJson: stableSerialize(policy),
    policyHash: policy.policyHash,
    updatedByClientId: policy.updatedByClientId,
    createdAt: new Date(policy.updatedAt),
    updatedAt: new Date(policy.updatedAt),
  }
}

function stateData(state: Readonly<BatchEditItemState>) {
  return {
    workspaceId: state.workspaceId,
    batchId: state.batchId,
    itemId: state.itemId,
    revision: state.revision,
    schemaVersion: state.schemaVersion,
    directivesJson: stableSerialize(state.directives),
    protectedOperationsJson: stableSerialize(
      state.protectedOperations,
    ),
    stateJson: stableSerialize(state),
    stateHash: state.stateHash,
    previousStateHash: state.previousStateHash ?? null,
    sourceCommandId: state.sourceCommandId ?? null,
    createdByClientId: state.createdByClientId,
    createdAt: new Date(state.createdAt),
  }
}

function preflightData(
  record: Readonly<BatchEditPreflightRecord>,
) {
  const { run } = record
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    schemaVersion: run.schemaVersion,
    impactVersion: run.impactVersion,
    status: run.status,
    mode: run.mode,
    operationType: run.operation.type,
    operationValueRef: run.operation.valueRef,
    resultJson: stableSerialize(run),
    policyHash: run.policy.policyHash,
    batchRevision: run.batchRevision,
    batchDefinitionHash: run.batchDefinitionHash,
    scopeHash: run.scope.scopeHash,
    budgetRemainingMinorUnits: run.budgetRemainingMinorUnits,
    affectedItemCount: run.affectedItemCount,
    applicableItemCount: run.applicableItemCount,
    protectedConflictCount: run.protectedConflictCount,
    unchangedItemCount: run.unchangedItemCount,
    invalidationCount: run.invalidationCount,
    estimatedCostMinorUnits: run.estimatedCostMinorUnits,
    budgetExceeded: run.budgetExceeded,
    confirmationExpiresAt: run.confirmationExpiresAt
      ? new Date(run.confirmationExpiresAt)
      : null,
    costFingerprint: run.costFingerprint,
    preflightHash: run.preflightHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: run.createdByClientId,
    createdAt: new Date(run.createdAt),
  }
}

function commandData(
  record: Readonly<BatchEditCommandRecord>,
) {
  const { command } = record
  return {
    id: command.id,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    batchId: command.batchId,
    preflightId: command.preflightId,
    preflightHash: command.preflightHash,
    schemaVersion: command.schemaVersion,
    status: command.status,
    mode: command.mode,
    operationType: command.operation.type,
    operationValueRef: command.operation.valueRef,
    resultJson: stableSerialize(command),
    batchRevision: command.batchRevision,
    batchDefinitionHash: command.batchDefinitionHash,
    policyHash: command.policyHash,
    scopeHash: command.scope.scopeHash,
    affectedItemCount: command.affectedItemCount,
    appliedItemCount: command.appliedItemCount,
    skippedItemCount: command.skippedItemCount,
    unchangedItemCount: command.unchangedItemCount,
    invalidationCount: command.invalidationCount,
    costMinorUnits: command.costMinorUnits,
    commandHash: command.commandHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: command.createdByClientId,
    createdAt: new Date(command.createdAt),
  }
}

function commandItemData(
  command: Readonly<BatchEditCommand>,
  result: Readonly<BatchEditCommand['resultItems'][number]>,
) {
  return {
    workspaceId: command.workspaceId,
    batchId: command.batchId,
    commandId: command.id,
    itemId: result.itemId,
    status: result.status,
    targetRef: result.targetRef,
    beforeStateRevision: result.beforeStateRevision,
    beforeStateHash: result.beforeStateHash,
    afterStateRevision: result.afterStateRevision ?? null,
    afterStateHash: result.afterStateHash ?? null,
    costMinorUnits: result.costMinorUnits,
    resultJson: stableSerialize(result),
    resultHash: result.resultHash,
  }
}

function invalidationData(
  command: Readonly<BatchEditCommand>,
  result: Readonly<BatchEditCommand['resultItems'][number]>,
  step: BatchEditCommand['resultItems'][number]['invalidatedSteps'][number],
  sequence: number,
) {
  const targetRef = result.invalidatedTargetRefs[sequence]!
  const content = {
    schemaVersion: 'batch-edit-invalidation/v1',
    commandId: command.id,
    itemId: result.itemId,
    step,
    sequence,
    targetRef,
  }
  return {
    workspaceId: command.workspaceId,
    batchId: command.batchId,
    commandId: command.id,
    itemId: result.itemId,
    step,
    sequence,
    targetRef,
    invalidationHash: calculateCanonicalHash(content),
    createdAt: new Date(command.createdAt),
  }
}

function latestStates(
  rows: readonly V2BatchEditItemStateVersion[],
): Map<string, Readonly<BatchEditItemState>> {
  const states = new Map<string, Readonly<BatchEditItemState>>()
  for (const row of rows) {
    if (!states.has(row.itemId)) {
      states.set(row.itemId, hydrateBatchEditItemStateRow(row))
    }
  }
  return states
}

async function reservedEditCost(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  batchId: string,
): Promise<number> {
  const aggregate = await transaction.v2BatchEditCommand.aggregate({
    where: { workspaceId, batchId },
    _sum: { costMinorUnits: true },
  })
  return aggregate._sum.costMinorUnits ?? 0
}

export class PrismaBatchEditRepository
implements BatchEditRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async loadPreflightContext(input: {
    workspaceId: string
    batchId: string
    expectedBatchRevision: number
    expectedBatchDefinitionHash: string
    itemIds: readonly string[]
    actorClientId: string
    createdAt: string
  }, attempt = 1): Promise<Readonly<{
    projectId: string
    batchRevision: number
    batchDefinitionHash: string
    availableRecipeIds: readonly string[]
    availableOutputSpecIds: readonly string[]
    availableItemIds: readonly string[]
    items: readonly Readonly<{
      itemId: string
      recipeId: string
      variantId: string
      outputSpecId: string
      locale: string
      state: Readonly<BatchEditItemState>
    }>[]
    budgetRemainingMinorUnits: number
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const [batch, actor, items] = await Promise.all([
          transaction.v2ProductionBatch.findFirst({
            where: {
              id: input.batchId,
              workspaceId: input.workspaceId,
            },
            select: {
              projectId: true,
              revision: true,
              definitionHash: true,
              recipesJson: true,
              variantsJson: true,
              maxCostMinorUnits: true,
              reservedCostMinorUnits: true,
            },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: input.actorClientId,
              workspaceId: input.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
          transaction.v2ProductionBatchItem.findMany({
            where: {
              workspaceId: input.workspaceId,
              batchId: input.batchId,
            },
            select: {
              id: true,
              recipeId: true,
              variantId: true,
            },
            orderBy: { sequence: 'asc' },
          }),
        ])
        if (!batch) {
          throw new DomainError(
            'PRODUCTION_BATCH_NOT_FOUND',
            'Batch edit production batch was not found',
          )
        }
        if (!actor) {
          throw new DomainError(
            'API_CLIENT_NOT_FOUND',
            'Batch edit actor was not found or is inactive',
          )
        }
        if (
          batch.revision !== input.expectedBatchRevision ||
          batch.definitionHash !==
            input.expectedBatchDefinitionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Production batch revision or definition is stale',
          )
        }
        const recipes = canonicalJson<
          readonly Readonly<ProductionBatchRecipe>[]
        >(batch.recipesJson, 'production batch recipes')
        const variants = canonicalJson<
          readonly Readonly<ProductionBatchVariant>[]
        >(batch.variantsJson, 'production batch variants')
        const selected = items.filter((item) =>
          input.itemIds.includes(item.id))
        if (selected.length !== input.itemIds.length) {
          throw new DomainError(
            'PRODUCTION_BATCH_ITEM_NOT_FOUND',
            'One or more explicit batch edit targets were not found',
          )
        }
        const stateRows =
          await transaction.v2BatchEditItemStateVersion.findMany({
            where: {
              workspaceId: input.workspaceId,
              batchId: input.batchId,
              itemId: { in: [...input.itemIds] },
            },
            orderBy: [
              { itemId: 'asc' },
              { revision: 'desc' },
            ],
          })
        const states = latestStates(stateRows)
        for (const itemId of input.itemIds) {
          if (states.has(itemId)) continue
          const baseline = createBatchEditItemState({
            workspaceId: input.workspaceId,
            batchId: input.batchId,
            itemId,
            createdByClientId: input.actorClientId,
            createdAt: input.createdAt,
          })
          const row =
            await transaction.v2BatchEditItemStateVersion.upsert({
              where: {
                itemId_revision: { itemId, revision: 1 },
              },
              create: stateData(baseline),
              update: {},
            })
          states.set(itemId, hydrateBatchEditItemStateRow(row))
        }
        const variantsById = new Map(
          variants.map((variant) => [variant.id, variant]),
        )
        const contexts = selected.map((item) => {
          const variant = variantsById.get(item.variantId)
          const state = states.get(item.id)
          if (!variant || !state) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              `Production batch target ${item.id} has an invalid variant or state`,
            )
          }
          return Object.freeze({
            itemId: item.id,
            recipeId: item.recipeId,
            variantId: item.variantId,
            outputSpecId: variant.outputSpecId,
            locale: variant.locale,
            state,
          })
        })
        const editCost = await reservedEditCost(
          transaction,
          input.workspaceId,
          input.batchId,
        )
        return Object.freeze({
          projectId: batch.projectId,
          batchRevision: batch.revision,
          batchDefinitionHash: batch.definitionHash,
          availableRecipeIds: Object.freeze(
            recipes.map((recipe) => recipe.id).toSorted(),
          ),
          availableOutputSpecIds: Object.freeze([
            ...new Set(variants.map((variant) =>
              variant.outputSpecId)),
          ].toSorted()),
          availableItemIds: Object.freeze(
            items.map((item) => item.id).toSorted(),
          ),
          items: Object.freeze(contexts),
          budgetRemainingMinorUnits: Math.max(
            0,
            batch.maxCostMinorUnits -
              batch.reservedCostMinorUnits -
              editCost,
          ),
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.loadPreflightContext(input, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Batch edit context conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async loadCommitStates(input: {
    workspaceId: string
    batchId: string
    itemIds: readonly string[]
  }) {
    const rows =
      await this.prisma.v2BatchEditItemStateVersion.findMany({
        where: {
          workspaceId: input.workspaceId,
          batchId: input.batchId,
          itemId: { in: [...input.itemIds] },
        },
        orderBy: [
          { itemId: 'asc' },
          { revision: 'desc' },
        ],
      })
    const states = latestStates(rows)
    if (states.size !== input.itemIds.length) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'One or more batch edit target states are missing',
      )
    }
    return Object.freeze(
      input.itemIds.map((itemId) => states.get(itemId)!),
    )
  }

  async readPolicy(input: { workspaceId: string }) {
    const row = await this.prisma.v2BatchEditPolicy.findFirst({
      where: { workspaceId: input.workspaceId },
      orderBy: { revision: 'desc' },
    })
    return row ? hydrateBatchEditPolicyRow(row) : null
  }

  async ensurePolicy(policy: Readonly<BatchEditPolicy>) {
    const current = await this.readPolicy({
      workspaceId: policy.workspaceId,
    })
    if (current) return current
    try {
      const row = await this.prisma.v2BatchEditPolicy.create({
        data: policyData(policy),
      })
      return hydrateBatchEditPolicyRow(row)
    } catch (error) {
      if (isPrismaCode(error, 'P2002')) {
        const raced = await this.readPolicy({
          workspaceId: policy.workspaceId,
        })
        if (raced) return raced
      }
      throw error
    }
  }

  async findPreflightReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<BatchEditPreflightReplay> | null> {
    const row = await this.prisma.v2BatchEditPreflightRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row
      ? Object.freeze({
          run: hydrateBatchEditPreflightRow(row),
          requestFingerprint: row.requestFingerprint,
        })
      : null
  }

  async createPreflight(
    record: Readonly<BatchEditPreflightRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<BatchEditPreflightRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2BatchEditPreflightRun.findFirst({
            where: {
              workspaceId: record.run.workspaceId,
              createdByClientId: record.run.createdByClientId,
              idempotencyKey: record.idempotencyKey,
            },
          })
        if (replay) {
          if (
            replay.requestFingerprint !== record.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different batch edit preflight request',
            )
          }
          return Object.freeze({
            run: hydrateBatchEditPreflightRow(replay),
            replayed: true,
          })
        }
        const [batch, actor, policy, stateRows, editCost] =
          await Promise.all([
            transaction.v2ProductionBatch.findFirst({
              where: {
                id: record.run.batchId,
                workspaceId: record.run.workspaceId,
                projectId: record.run.projectId,
              },
              select: {
                revision: true,
                definitionHash: true,
                maxCostMinorUnits: true,
                reservedCostMinorUnits: true,
              },
            }),
            transaction.v2ApiClient.findFirst({
              where: {
                id: record.run.createdByClientId,
                workspaceId: record.run.workspaceId,
                status: 'active',
              },
              select: { id: true },
            }),
            transaction.v2BatchEditPolicy.findUnique({
              where: {
                workspaceId_policyHash: {
                  workspaceId: record.run.workspaceId,
                  policyHash: record.run.policy.policyHash,
                },
              },
              select: { policyHash: true },
            }),
            transaction.v2BatchEditItemStateVersion.findMany({
              where: {
                workspaceId: record.run.workspaceId,
                batchId: record.run.batchId,
                itemId: { in: [...record.run.scope.itemIds] },
              },
              orderBy: [
                { itemId: 'asc' },
                { revision: 'desc' },
              ],
            }),
            reservedEditCost(
              transaction,
              record.run.workspaceId,
              record.run.batchId,
            ),
          ])
        if (
          !batch ||
          batch.revision !== record.run.batchRevision ||
          batch.definitionHash !== record.run.batchDefinitionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Production batch changed before batch edit preflight persistence',
          )
        }
        if (!actor || !policy) {
          throw new DomainError(
            'PRECONDITION_REQUIRED',
            'Batch edit actor or policy is no longer available',
          )
        }
        const states = latestStates(stateRows)
        if (
          states.size !== record.run.affectedItemCount ||
          !record.run.impacts.every((impact) =>
            states.get(impact.itemId)?.stateHash ===
              impact.beforeStateHash)
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Batch edit target state changed before preflight persistence',
          )
        }
        const budgetRemaining = Math.max(
          0,
          batch.maxCostMinorUnits -
            batch.reservedCostMinorUnits -
            editCost,
        )
        if (
          budgetRemaining !== record.run.budgetRemainingMinorUnits
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Batch edit budget changed before preflight persistence',
          )
        }
        const persisted =
          await transaction.v2BatchEditPreflightRun.create({
            data: preflightData(record),
          })
        return Object.freeze({
          run: hydrateBatchEditPreflightRow(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.createPreflight(record, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findPreflightReplay({
          workspaceId: record.run.workspaceId,
          actorClientId: record.run.createdByClientId,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (
            replay.requestFingerprint !== record.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different batch edit preflight request',
            )
          }
          return Object.freeze({ run: replay.run, replayed: true })
        }
      }
      if (
        isPrismaCode(error, 'P2034') ||
        isPrismaCode(error, 'P2002')
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Batch edit preflight conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async readPreflightRecord(input: {
    workspaceId: string
    batchId: string
    preflightId: string
  }): Promise<Readonly<BatchEditPreflightRecord> | null> {
    const row = await this.prisma.v2BatchEditPreflightRun.findFirst({
      where: {
        id: input.preflightId,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
      },
    })
    return row
      ? Object.freeze({
          run: hydrateBatchEditPreflightRow(row),
          requestFingerprint: row.requestFingerprint,
          idempotencyKey: row.idempotencyKey,
        })
      : null
  }

  async listPreflights(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<BatchEditPreflightPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2BatchEditPreflightRun.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            batchId: input.batchId,
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'Batch edit preflight cursor is invalid',
      )
    }
    const rows = await this.prisma.v2BatchEditPreflightRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    })
    const hasMore = rows.length > input.limit
    const page = rows.slice(0, input.limit)
    return Object.freeze({
      preflights: Object.freeze(page.map(hydrateBatchEditPreflightRow)),
      ...(hasMore && page.at(-1)
        ? { nextCursor: page.at(-1)!.id }
        : {}),
    })
  }

  async findCommandReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<BatchEditCommandReplay> | null> {
    const row = await this.prisma.v2BatchEditCommand.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      include: commandInclude,
    })
    return row
      ? Object.freeze({
          command: hydrateBatchEditCommandRow(row),
          requestFingerprint: row.requestFingerprint,
        })
      : null
  }

  async commit(
    record: Readonly<BatchEditCommandRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    command: Readonly<BatchEditCommand>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2BatchEditCommand.findFirst({
            where: {
              workspaceId: record.command.workspaceId,
              createdByClientId: record.command.createdByClientId,
              idempotencyKey: record.idempotencyKey,
            },
            include: commandInclude,
          })
        if (replay) {
          if (
            replay.requestFingerprint !== record.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different batch edit commit request',
            )
          }
          return Object.freeze({
            command: hydrateBatchEditCommandRow(replay),
            replayed: true,
          })
        }
        const existing =
          await transaction.v2BatchEditCommand.findUnique({
            where: { preflightId: record.command.preflightId },
            include: commandInclude,
          })
        if (existing) {
          if (
            existing.requestFingerprint !==
              record.requestFingerprint ||
            existing.createdByClientId !==
              record.command.createdByClientId
          ) {
            throw new DomainError(
              'VERSION_CONFLICT',
              'Batch edit preflight was already committed by another request',
            )
          }
          return Object.freeze({
            command: hydrateBatchEditCommandRow(existing),
            replayed: true,
          })
        }
        const [preflightRow, batch, actor, policy, stateRows, editCost] =
          await Promise.all([
            transaction.v2BatchEditPreflightRun.findFirst({
              where: {
                id: record.command.preflightId,
                workspaceId: record.command.workspaceId,
                batchId: record.command.batchId,
                preflightHash: record.command.preflightHash,
              },
            }),
            transaction.v2ProductionBatch.findFirst({
              where: {
                id: record.command.batchId,
                workspaceId: record.command.workspaceId,
                projectId: record.command.projectId,
              },
              select: {
                revision: true,
                definitionHash: true,
                maxCostMinorUnits: true,
                reservedCostMinorUnits: true,
              },
            }),
            transaction.v2ApiClient.findFirst({
              where: {
                id: record.command.createdByClientId,
                workspaceId: record.command.workspaceId,
                status: 'active',
              },
              select: { id: true },
            }),
            transaction.v2BatchEditPolicy.findUnique({
              where: {
                workspaceId_policyHash: {
                  workspaceId: record.command.workspaceId,
                  policyHash: record.command.policyHash,
                },
              },
              select: { policyHash: true },
            }),
            transaction.v2BatchEditItemStateVersion.findMany({
              where: {
                workspaceId: record.command.workspaceId,
                batchId: record.command.batchId,
                itemId: { in: [...record.command.scope.itemIds] },
              },
              orderBy: [
                { itemId: 'asc' },
                { revision: 'desc' },
              ],
            }),
            reservedEditCost(
              transaction,
              record.command.workspaceId,
              record.command.batchId,
            ),
          ])
        if (!preflightRow) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Batch edit preflight changed before commit',
          )
        }
        const preflight = hydrateBatchEditPreflightRow(preflightRow)
        if (
          preflight.scope.scopeHash !==
            record.command.scope.scopeHash ||
          preflight.policy.policyHash !==
            record.command.policyHash ||
          preflight.createdByClientId !==
            record.command.createdByClientId ||
          !preflight.confirmationExpiresAt ||
          new Date(record.command.createdAt) >
            new Date(preflight.confirmationExpiresAt)
        ) {
          throw new DomainError(
            'PREFLIGHT_TOKEN_STALE',
            'Batch edit preflight no longer matches the commit',
          )
        }
        if (
          !batch ||
          batch.revision !== record.command.batchRevision ||
          batch.definitionHash !==
            record.command.batchDefinitionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Production batch changed before batch edit commit',
          )
        }
        if (!actor || !policy) {
          throw new DomainError(
            'PRECONDITION_REQUIRED',
            'Batch edit actor or policy is no longer available',
          )
        }
        const states = latestStates(stateRows)
        if (
          states.size !== record.command.affectedItemCount ||
          !record.command.resultItems.every((result) =>
            states.get(result.itemId)?.stateHash ===
              result.beforeStateHash)
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Batch edit target state changed after preflight',
          )
        }
        const availableBudget = Math.max(
          0,
          batch.maxCostMinorUnits -
            batch.reservedCostMinorUnits -
            editCost,
        )
        if (record.command.costMinorUnits > availableBudget) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Batch edit cost no longer fits the available budget',
          )
        }
        await transaction.v2BatchEditCommand.create({
          data: commandData(record),
        })
        await transaction.v2BatchEditItemStateVersion.createMany({
          data: record.command.newStates.map(stateData),
        })
        await transaction.v2BatchEditCommandItem.createMany({
          data: record.command.resultItems.map((result) =>
            commandItemData(record.command, result)),
        })
        const invalidations = record.command.resultItems.flatMap(
          (result) => result.invalidatedSteps.map((step, sequence) =>
            invalidationData(
              record.command,
              result,
              step,
              sequence,
            )),
        )
        if (invalidations.length > 0) {
          await transaction.v2BatchEditInvalidation.createMany({
            data: invalidations,
          })
        }
        const persisted =
          await transaction.v2BatchEditCommand.findUniqueOrThrow({
            where: { id: record.command.id },
            include: commandInclude,
          })
        return Object.freeze({
          command: hydrateBatchEditCommandRow(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.commit(record, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findCommandReplay({
          workspaceId: record.command.workspaceId,
          actorClientId: record.command.createdByClientId,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (
            replay.requestFingerprint !== record.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different batch edit commit request',
            )
          }
          return Object.freeze({
            command: replay.command,
            replayed: true,
          })
        }
      }
      if (
        isPrismaCode(error, 'P2034') ||
        isPrismaCode(error, 'P2002') ||
        isPrismaCode(error, 'P2003')
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Batch edit commit conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async readCommand(input: {
    workspaceId: string
    batchId: string
    commandId: string
  }) {
    const row = await this.prisma.v2BatchEditCommand.findFirst({
      where: {
        id: input.commandId,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
      },
      include: commandInclude,
    })
    return row ? hydrateBatchEditCommandRow(row) : null
  }

  async listCommands(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<BatchEditCommandPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2BatchEditCommand.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            batchId: input.batchId,
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'Batch edit command cursor is invalid',
      )
    }
    const rows = await this.prisma.v2BatchEditCommand.findMany({
      where: {
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      include: commandInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    })
    const hasMore = rows.length > input.limit
    const page = rows.slice(0, input.limit)
    return Object.freeze({
      commands: Object.freeze(page.map(hydrateBatchEditCommandRow)),
      ...(hasMore && page.at(-1)
        ? { nextCursor: page.at(-1)!.id }
        : {}),
    })
  }
}
