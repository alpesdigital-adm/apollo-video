import {
  Prisma,
  type PrismaClient,
  type V2ProductionBatch,
  type V2ProductionBatchItem,
  type V2ProductionBatchItemArtifact,
  type V2ProductionBatchAction,
  type V2ProductionBatchRetryJob,
  type V2ProductionBatchStep,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ProductionBatchActionRecord,
  ProductionBatchCreateRecord,
  ProductionBatchPage,
  ProductionBatchPartialRetryPage,
  ProductionBatchPartialRetryReplay,
  ProductionBatchReplay,
  ProductionBatchRepository,
} from '../../application/ports/production-batch-repository.ts'
import {
  createBatchPartialRetry,
  hydrateBatchPartialRetry,
  type BatchPartialRetryJob,
  type BatchPartialRetryRun,
} from '../../domain/batch-partial-retry.ts'
import {
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  batchProgress,
  deriveBatchStatus,
  hydrateProductionBatch,
  type BatchItem,
  type BatchItemStep,
  type ProductionBatch,
  type ProductionBatchRecipe,
  type ProductionBatchSourceGroup,
  type ProductionBatchStatus,
  type ProductionBatchVariant,
} from '../../domain/production-batch.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { batchActorAuditData, hydrateBatchActorAudit } from './batch-actor-audit.ts'

type ItemRow = V2ProductionBatchItem & {
  steps: V2ProductionBatchStep[]
  artifacts: V2ProductionBatchItemArtifact[]
}

type BatchRow = V2ProductionBatch & {
  items: ItemRow[]
}

type PartialRetryActionRow = V2ProductionBatchAction & {
  retryJobs: V2ProductionBatchRetryJob[]
}

const batchInclude = {
  items: {
    include: {
      steps: true,
      artifacts: true,
    },
  },
} satisfies Prisma.V2ProductionBatchInclude

const partialRetryActionInclude = {
  retryJobs: true,
} satisfies Prisma.V2ProductionBatchActionInclude

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

function hydrateStep(
  row: V2ProductionBatchStep,
): Readonly<BatchItemStep> {
  return Object.freeze({
    step: row.step as BatchItemStep['step'],
    sequence: row.sequence,
    state: row.state as BatchItemStep['state'],
    attempt: row.attempt,
    costMinorUnits: row.costMinorUnits,
    cacheHit: row.cacheHit,
    ...(row.errorCode && row.errorMessage
      ? {
          error: Object.freeze({
            code: row.errorCode,
            message: row.errorMessage,
          }),
        }
      : {}),
    stepHash: row.stepHash,
  })
}

function hydrateItem(row: ItemRow): Readonly<BatchItem> {
  return Object.freeze({
    id: row.id,
    key: row.key,
    sourceGroupId: row.sourceGroupId,
    recipeId: row.recipeId,
    variantId: row.variantId,
    state: row.state as BatchItem['state'],
    revision: row.revision,
    steps: Object.freeze(
      [...row.steps]
        .sort((left, right) => left.sequence - right.sequence)
        .map(hydrateStep),
    ),
    artifactIds: Object.freeze(
      [...row.artifacts]
        .sort((left, right) => left.sequence - right.sequence)
        .map((artifact) => artifact.artifactId),
    ),
    retryCount: row.retryCount,
    ...(row.errorCode && row.errorMessage
      ? {
          error: Object.freeze({
            code: row.errorCode,
            message: row.errorMessage,
          }),
        }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    itemHash: row.itemHash,
  })
}

function hydrateBatch(row: BatchRow): Readonly<ProductionBatch> {
  const authenticationAudit = hydrateBatchActorAudit(row, row.createdByClientId)
  const sourceGroups = canonicalJson<
    readonly Readonly<ProductionBatchSourceGroup>[]
  >(row.sourceGroupsJson, 'production batch source groups')
  const recipes = canonicalJson<
    readonly Readonly<ProductionBatchRecipe>[]
  >(row.recipesJson, 'production batch recipes')
  const variants = canonicalJson<
    readonly Readonly<ProductionBatchVariant>[]
  >(row.variantsJson, 'production batch variants')
  const budget = canonicalJson<ProductionBatch['budget']>(
    row.budgetJson,
    'production batch budget',
  )
  const items = Object.freeze(
    [...row.items]
      .sort((left, right) => left.sequence - right.sequence)
      .map(hydrateItem),
  )
  const batch = hydrateProductionBatch({
    schemaVersion: row.schemaVersion as ProductionBatch['schemaVersion'],
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    objective: row.objective,
    policyVersion: row.policyVersion as ProductionBatch['policyVersion'],
    revision: row.revision,
    sourceGroups,
    recipes,
    variants,
    budget,
    items,
    createdBy: Object.freeze({
      type: 'api-client',
      id: row.createdByClientId,
      ...(authenticationAudit.delegatedUserId
        ? { delegatedUserId: authenticationAudit.delegatedUserId }
        : {}),
    }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    definitionHash: row.definitionHash,
  })
  if (
    items.length !== row.itemCount ||
    budget.maxCostMinorUnits !== row.maxCostMinorUnits ||
    budget.reservedCostMinorUnits !== row.reservedCostMinorUnits ||
    deriveBatchStatus(batch) !== row.aggregateStatus
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored production batch ${row.id} has inconsistent aggregates`,
    )
  }
  return batch
}

function hydrateResponseJson(value: string): Readonly<ProductionBatch> {
  const response = canonicalJson<{ batch: ProductionBatch }>(
    value,
    'production batch action response',
  )
  if (!response.batch) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored production batch action response has no batch',
    )
  }
  return hydrateProductionBatch(response.batch)
}

function retryJobFromRow(
  row: V2ProductionBatchRetryJob,
): Readonly<BatchPartialRetryJob> {
  return Object.freeze({
    schemaVersion: row.schemaVersion as BatchPartialRetryJob['schemaVersion'],
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    batchId: row.batchId,
    retryId: row.actionId,
    itemId: row.itemId,
    step: row.step as BatchPartialRetryJob['step'],
    executorClass:
      row.executorClass as BatchPartialRetryJob['executorClass'],
    status: row.status as BatchPartialRetryJob['status'],
    lineageKey: row.lineageKey,
    failedAttempt: row.failedAttempt,
    retryAttempt: row.retryAttempt,
    previousStepHash: row.previousStepHash,
    queuedStepHash: row.queuedStepHash,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    preservedArtifactIds: canonicalJson<readonly string[]>(
      row.preservedArtifactIdsJson,
      'production batch retry job preserved artifacts',
    ),
    preservedArtifactCount: row.preservedArtifactCount,
    chargedMinorUnitsAtEnqueue:
      row.chargedMinorUnitsAtEnqueue as 0,
    createdAt: row.createdAt.toISOString(),
    jobHash: row.jobHash,
  })
}

function hydratePartialRetryAction(
  row: PartialRetryActionRow,
): Readonly<BatchPartialRetryRun> {
  hydrateBatchActorAudit(row, row.actorClientId)
  if (
    row.action !== 'partial-retry' ||
    row.scope !== 'batch' ||
    row.itemId !== null ||
    row.step !== null ||
    row.expectedItemRevision !== null ||
    !row.retryManifestJson ||
    !row.retryManifestHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored production batch action ${row.id} is not a partial retry`,
    )
  }
  const partialRetry = hydrateBatchPartialRetry(
    canonicalJson<BatchPartialRetryRun>(
      row.retryManifestJson,
      'production batch partial retry manifest',
    ),
  )
  const relationalJobs = Object.freeze(
    [...row.retryJobs]
      .sort((left, right) =>
        left.id.localeCompare(right.id))
      .map(retryJobFromRow),
  )
  const manifestJobs = Object.freeze(
    [...partialRetry.jobs]
      .sort((left, right) =>
        left.id.localeCompare(right.id)),
  )
  if (
    row.retryManifestHash !== partialRetry.retryHash ||
    row.id !== partialRetry.id ||
    row.workspaceId !== partialRetry.workspaceId ||
    row.batchId !== partialRetry.batchId ||
    row.actorClientId !== partialRetry.createdByClientId ||
    row.expectedBatchRevision !==
      partialRetry.batchRevisionBefore ||
    row.createdAt.toISOString() !== partialRetry.createdAt ||
    stableSerialize(partialRetry) !== row.retryManifestJson ||
    stableSerialize(relationalJobs) !== stableSerialize(manifestJobs)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored production batch partial retry ${row.id} is inconsistent`,
    )
  }
  return partialRetry
}

function assertPartialRetryTransition(input: {
  record: Readonly<ProductionBatchActionRecord>
  current: Readonly<ProductionBatch>
  next: Readonly<ProductionBatch>
  partialRetry: Readonly<BatchPartialRetryRun>
}): void {
  const { record, current, next, partialRetry } = input
  if (
    record.id !== partialRetry.id ||
    record.workspaceId !== partialRetry.workspaceId ||
    record.batchId !== partialRetry.batchId ||
    record.actorClientId !== partialRetry.createdByClientId ||
    record.createdAt !== partialRetry.createdAt ||
    current.projectId !== partialRetry.projectId ||
    current.definitionHash !== partialRetry.batchDefinitionHash ||
    current.revision !== partialRetry.batchRevisionBefore ||
    next.revision !== partialRetry.batchRevisionAfter ||
    stableSerialize(batchProgress(current)) !==
      stableSerialize(partialRetry.progressBefore) ||
    stableSerialize(batchProgress(next)) !==
      stableSerialize(partialRetry.progressAfter)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Production batch partial retry does not match its action',
    )
  }
  const compiled = createBatchPartialRetry({
    id: partialRetry.id,
    batch: current,
    expectedBatchRevision: partialRetry.batchRevisionBefore,
    targets: partialRetry.jobs.map((job) => {
      const item = current.items.find((candidate) =>
        candidate.id === job.itemId)
      if (!item) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          `Partial retry item ${job.itemId} is missing`,
        )
      }
      return Object.freeze({
        itemId: job.itemId,
        step: job.step,
        expectedItemRevision: item.revision,
        expectedStepHash: job.previousStepHash,
      })
    }),
    actorClientId: partialRetry.createdByClientId,
    createdAt: partialRetry.createdAt,
    createJobId: (_target, index) =>
      partialRetry.jobs[index]!.id,
  })
  if (
    stableSerialize(compiled.retry) !==
      stableSerialize(partialRetry) ||
    stableSerialize(compiled.batch) !== stableSerialize(next)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Production batch partial retry transition was not deterministic',
    )
  }
}

function batchData(record: Readonly<ProductionBatchCreateRecord>) {
  const { batch } = record
  return {
    id: batch.id,
    workspaceId: batch.workspaceId,
    projectId: batch.projectId,
    schemaVersion: batch.schemaVersion,
    policyVersion: batch.policyVersion,
    name: batch.name,
    objective: batch.objective,
    aggregateStatus: deriveBatchStatus(batch),
    revision: batch.revision,
    sourceGroupsJson: stableSerialize(batch.sourceGroups),
    recipesJson: stableSerialize(batch.recipes),
    variantsJson: stableSerialize(batch.variants),
    budgetJson: stableSerialize(batch.budget),
    maxCostMinorUnits: batch.budget.maxCostMinorUnits,
    reservedCostMinorUnits: batch.budget.reservedCostMinorUnits,
    itemCount: batch.items.length,
    definitionHash: batch.definitionHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: batch.createdBy.id,
    ...batchActorAuditData(
      record.authenticationAudit,
      batch.workspaceId,
      batch.createdBy.id,
    ),
    createdAt: new Date(batch.createdAt),
    updatedAt: new Date(batch.updatedAt),
  }
}

function itemData(
  batch: Readonly<ProductionBatch>,
  item: Readonly<BatchItem>,
  sequence: number,
) {
  return {
    id: item.id,
    workspaceId: batch.workspaceId,
    batchId: batch.id,
    sequence,
    key: item.key,
    sourceGroupId: item.sourceGroupId,
    recipeId: item.recipeId,
    variantId: item.variantId,
    state: item.state,
    revision: item.revision,
    retryCount: item.retryCount,
    errorCode: item.error?.code,
    errorMessage: item.error?.message,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
    itemHash: item.itemHash,
  }
}

function stepData(
  batch: Readonly<ProductionBatch>,
  item: Readonly<BatchItem>,
  step: Readonly<BatchItemStep>,
) {
  return {
    workspaceId: batch.workspaceId,
    batchId: batch.id,
    itemId: item.id,
    step: step.step,
    sequence: step.sequence,
    state: step.state,
    attempt: step.attempt,
    costMinorUnits: step.costMinorUnits,
    cacheHit: step.cacheHit,
    errorCode: step.error?.code,
    errorMessage: step.error?.message,
    stepHash: step.stepHash,
    updatedAt: new Date(item.updatedAt),
  }
}

function allArtifactIds(
  batch: Readonly<ProductionBatch>,
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...batch.sourceGroups.flatMap((group) => group.sourceArtifactIds),
      ...batch.items.flatMap((item) => item.artifactIds),
    ]),
  ])
}

async function assertCreationContext(
  transaction: Prisma.TransactionClient,
  record: Readonly<ProductionBatchCreateRecord>,
): Promise<void> {
  const { batch } = record
  const sourceArtifactIds = [
    ...new Set(batch.sourceGroups.flatMap((group) =>
      group.sourceArtifactIds)),
  ]
  const [project, actor, artifacts] = await Promise.all([
    transaction.v2Project.findFirst({
      where: {
        id: batch.projectId,
        workspaceId: batch.workspaceId,
      },
      select: { id: true },
    }),
    transaction.v2ApiClient.findFirst({
      where: {
        id: batch.createdBy.id,
        workspaceId: batch.workspaceId,
        status: 'active',
      },
      select: { id: true },
    }),
    transaction.v2MediaArtifact.findMany({
      where: {
        workspaceId: batch.workspaceId,
        id: { in: sourceArtifactIds },
        status: 'available',
      },
      include: { currentRightsSnapshot: true },
    }),
  ])
  if (!project) {
    throw new DomainError(
      'PROJECT_NOT_FOUND',
      'Production batch project was not found',
    )
  }
  if (!actor) {
    throw new DomainError(
      'API_CLIENT_NOT_FOUND',
      'Production batch actor was not found',
    )
  }
  if (artifacts.length !== sourceArtifactIds.length) {
    throw new DomainError(
      'MEDIA_ARTIFACT_NOT_FOUND',
      'One or more production batch source artifacts were not found',
    )
  }
  const blocked = artifacts.find((artifact) =>
    !artifact.currentRightsSnapshot ||
    artifact.currentRightsSnapshot.status !== 'approved' ||
    !['approved', 'not-required'].includes(
      artifact.currentRightsSnapshot.consentStatus,
    ))
  if (blocked) {
    throw new DomainError(
      'ASSET_RIGHTS_BLOCKED',
      'Production batch source rights or consent are not approved',
    )
  }
}

export class PrismaProductionBatchRepository
implements ProductionBatchRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchReplay> | null> {
    const row = await this.prisma.v2ProductionBatch.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      include: batchInclude,
    })
    if (row) {
      if (hydrateBatchActorAudit(row, row.createdByClientId).contextHash !== input.actorContextHash) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
      }
      return Object.freeze({
          batch: hydrateBatch(row),
          requestFingerprint: row.requestFingerprint,
        })
    }
    return null
  }

  async create(
    record: Readonly<ProductionBatchCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    batch: Readonly<ProductionBatch>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2ProductionBatch.findFirst({
          where: {
            workspaceId: record.batch.workspaceId,
            createdByClientId: record.batch.createdBy.id,
            idempotencyKey: record.idempotencyKey,
          },
          include: batchInclude,
        })
        if (replay) {
          if (hydrateBatchActorAudit(replay, replay.createdByClientId).contextHash !== record.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
          }
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different production batch request',
            )
          }
          return Object.freeze({
            batch: hydrateBatch(replay),
            replayed: true,
          })
        }
        await assertCreationContext(transaction, record)
        await transaction.v2ProductionBatch.create({
          data: batchData(record),
        })
        await transaction.v2ProductionBatchItem.createMany({
          data: record.batch.items.map((item, sequence) =>
            itemData(record.batch, item, sequence)),
        })
        await transaction.v2ProductionBatchStep.createMany({
          data: record.batch.items.flatMap((item) =>
            item.steps.map((step) =>
              stepData(record.batch, item, step))),
        })
        const persisted =
          await transaction.v2ProductionBatch.findUniqueOrThrow({
            where: { id: record.batch.id },
            include: batchInclude,
          })
        return Object.freeze({
          batch: hydrateBatch(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.create(record, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findCreateReplay({
          workspaceId: record.batch.workspaceId,
          actorClientId: record.batch.createdBy.id,
          actorContextHash: record.authenticationAudit.contextHash,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different production batch request',
            )
          }
          return Object.freeze({
            batch: replay.batch,
            replayed: true,
          })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Production batch creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    batchId: string
  }): Promise<Readonly<ProductionBatch> | null> {
    const row = await this.prisma.v2ProductionBatch.findFirst({
      where: {
        id: input.batchId,
        workspaceId: input.workspaceId,
      },
      include: batchInclude,
    })
    return row ? hydrateBatch(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId?: string
    status?: ProductionBatchStatus
    query?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ProductionBatchPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2ProductionBatch.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'Production batch cursor is invalid',
      )
    }
    const and: Prisma.V2ProductionBatchWhereInput[] = []
    if (input.query) {
      and.push({
        OR: [
          {
            name: {
              contains: input.query,
              mode: Prisma.QueryMode.insensitive,
            },
          },
          {
            objective: {
              contains: input.query,
              mode: Prisma.QueryMode.insensitive,
            },
          },
        ],
      })
    }
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          {
            createdAt: cursor.createdAt,
            id: { lt: cursor.id },
          },
        ],
      })
    }
    const rows = await this.prisma.v2ProductionBatch.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.status ? { aggregateStatus: input.status } : {}),
        ...(and.length > 0 ? { AND: and } : {}),
      },
      include: batchInclude,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    })
    const hasNextPage = rows.length > input.limit
    const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows
    const batches = Object.freeze(pageRows.map(hydrateBatch))
    return Object.freeze({
      batches,
      ...(hasNextPage && batches.length > 0
        ? { nextCursor: batches.at(-1)!.id }
        : {}),
    })
  }

  async findActionReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchReplay> | null> {
    const row = await this.prisma.v2ProductionBatchAction.findFirst({
      where: {
        workspaceId: input.workspaceId,
        actorClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      select: {
        requestFingerprint: true,
        responseJson: true,
        actorClientId: true,
        actorCredentialId: true,
        actorEnvironment: true,
        actorAuthenticationKind: true,
        actorContextHash: true,
        delegatedUserId: true,
        delegatedIdentityId: true,
        workspaceRole: true,
        workspaceId: true,
      },
    })
    if (row) {
      if (hydrateBatchActorAudit(row, row.actorClientId).contextHash !== input.actorContextHash) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
      }
      return Object.freeze({
          batch: hydrateResponseJson(row.responseJson),
          requestFingerprint: row.requestFingerprint,
        })
    }
    return null
  }

  async findPartialRetryReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ProductionBatchPartialRetryReplay> | null> {
    const row = await this.prisma.v2ProductionBatchAction.findFirst({
      where: {
        workspaceId: input.workspaceId,
        actorClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      include: partialRetryActionInclude,
    })
    if (!row) return null
    if (hydrateBatchActorAudit(row, row.actorClientId).contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
    }
    if (row.action !== 'partial-retry') {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was used with a different production batch action',
      )
    }
    return Object.freeze({
      batch: hydrateResponseJson(row.responseJson),
      partialRetry: hydratePartialRetryAction(row),
      requestFingerprint: row.requestFingerprint,
    })
  }

  async readPartialRetry(input: {
    workspaceId: string
    batchId: string
    retryId: string
  }): Promise<Readonly<BatchPartialRetryRun> | null> {
    const row = await this.prisma.v2ProductionBatchAction.findFirst({
      where: {
        id: input.retryId,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        action: 'partial-retry',
      },
      include: partialRetryActionInclude,
    })
    return row ? hydratePartialRetryAction(row) : null
  }

  async listPartialRetries(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ProductionBatchPartialRetryPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2ProductionBatchAction.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            batchId: input.batchId,
            action: 'partial-retry',
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'Production batch partial retry cursor is invalid',
      )
    }
    const rows = await this.prisma.v2ProductionBatchAction.findMany({
      where: {
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        action: 'partial-retry',
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
      include: partialRetryActionInclude,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    })
    const hasNextPage = rows.length > input.limit
    const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows
    const retries = Object.freeze(
      pageRows.map(hydratePartialRetryAction),
    )
    return Object.freeze({
      retries,
      ...(hasNextPage && retries.length > 0
        ? { nextCursor: retries.at(-1)!.id }
        : {}),
    })
  }

  async persistAction(
    record: Readonly<ProductionBatchActionRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    batch: Readonly<ProductionBatch>
    replayed: boolean
    partialRetry?: Readonly<BatchPartialRetryRun>
  }>> {
    const partialRetry = record.partialRetry
      ? hydrateBatchPartialRetry(record.partialRetry)
      : undefined
    if (
      (record.action === 'partial-retry') !== Boolean(partialRetry) ||
      (partialRetry && (
        record.scope !== 'batch' ||
        record.itemId !== undefined ||
        record.step !== undefined ||
        record.expectedItemRevision !== undefined
      ))
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Production batch partial retry action is malformed',
      )
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2ProductionBatchAction.findFirst({
          where: {
            workspaceId: record.workspaceId,
            actorClientId: record.actorClientId,
            idempotencyKey: record.idempotencyKey,
          },
          include: partialRetryActionInclude,
        })
        if (replay) {
          if (hydrateBatchActorAudit(replay, replay.actorClientId).contextHash !== record.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
          }
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different production batch action',
            )
          }
          if (
            (record.action === 'partial-retry') !==
              (replay.action === 'partial-retry')
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different production batch action',
            )
          }
          return Object.freeze({
            batch: hydrateResponseJson(replay.responseJson),
            replayed: true,
            ...(replay.action === 'partial-retry'
              ? {
                  partialRetry: hydratePartialRetryAction(replay),
                }
              : {}),
          })
        }
        const currentRow =
          await transaction.v2ProductionBatch.findFirst({
            where: {
              id: record.batchId,
              workspaceId: record.workspaceId,
            },
            include: batchInclude,
          })
        if (!currentRow) {
          throw new DomainError(
            'PRODUCTION_BATCH_NOT_FOUND',
            'Production batch was not found',
          )
        }
        const current = hydrateBatch(currentRow)
        const next = hydrateProductionBatch(record.resultingBatch)
        if (
          current.revision !== record.expectedBatchRevision ||
          next.revision !== current.revision + 1 ||
          next.id !== current.id ||
          next.workspaceId !== current.workspaceId ||
          next.projectId !== current.projectId ||
          next.definitionHash !== current.definitionHash ||
          next.items.length !== current.items.length ||
          !next.items.every((item, index) =>
            item.id === current.items[index]?.id)
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Production batch changed before the action was committed',
          )
        }
        if (record.itemId) {
          const currentItem = current.items.find((item) =>
            item.id === record.itemId)
          const nextItem = next.items.find((item) =>
            item.id === record.itemId)
          if (
            !currentItem ||
            !nextItem ||
            currentItem.revision !== record.expectedItemRevision ||
            nextItem.revision !== currentItem.revision + 1
          ) {
            throw new DomainError(
              'VERSION_CONFLICT',
              'Production batch item changed before the action was committed',
            )
          }
        }
        if (partialRetry) {
          assertPartialRetryTransition({
            record,
            current,
            next,
            partialRetry,
          })
        }
        const [actor, artifacts] = await Promise.all([
          transaction.v2ApiClient.findFirst({
            where: {
              id: record.actorClientId,
              workspaceId: record.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
          transaction.v2MediaArtifact.findMany({
            where: {
              workspaceId: record.workspaceId,
              id: { in: [...allArtifactIds(next)] },
              status: 'available',
            },
            select: { id: true },
          }),
        ])
        if (!actor) {
          throw new DomainError(
            'API_CLIENT_NOT_FOUND',
            'Production batch action actor was not found',
          )
        }
        if (artifacts.length !== allArtifactIds(next).length) {
          throw new DomainError(
            'MEDIA_ARTIFACT_NOT_FOUND',
            'One or more production batch artifacts were not found',
          )
        }
        const rootUpdate = await transaction.v2ProductionBatch.updateMany({
          where: {
            id: current.id,
            workspaceId: current.workspaceId,
            revision: current.revision,
          },
          data: {
            aggregateStatus: deriveBatchStatus(next),
            revision: next.revision,
            updatedAt: new Date(next.updatedAt),
          },
        })
        if (rootUpdate.count !== 1) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Production batch revision is stale',
          )
        }
        for (const [sequence, item] of next.items.entries()) {
          const previous = current.items[sequence]!
          if (item.itemHash === previous.itemHash) continue
          const itemUpdate =
            await transaction.v2ProductionBatchItem.updateMany({
              where: {
                id: item.id,
                workspaceId: next.workspaceId,
                batchId: next.id,
                revision: previous.revision,
                itemHash: previous.itemHash,
              },
              data: {
                state: item.state,
                revision: item.revision,
                retryCount: item.retryCount,
                errorCode: item.error?.code ?? null,
                errorMessage: item.error?.message ?? null,
                updatedAt: new Date(item.updatedAt),
                itemHash: item.itemHash,
              },
            })
          if (itemUpdate.count !== 1) {
            throw new DomainError(
              'VERSION_CONFLICT',
              `Production batch item ${item.id} revision is stale`,
            )
          }
          for (const step of item.steps) {
            await transaction.v2ProductionBatchStep.update({
              where: {
                itemId_step: {
                  itemId: item.id,
                  step: step.step,
                },
              },
              data: {
                state: step.state,
                attempt: step.attempt,
                costMinorUnits: step.costMinorUnits,
                cacheHit: step.cacheHit,
                errorCode: step.error?.code ?? null,
                errorMessage: step.error?.message ?? null,
                stepHash: step.stepHash,
                updatedAt: new Date(item.updatedAt),
              },
            })
          }
          if (item.artifactIds.length > previous.artifactIds.length) {
            await transaction.v2ProductionBatchItemArtifact.createMany({
              data: item.artifactIds.map((artifactId, artifactSequence) => ({
                workspaceId: next.workspaceId,
                batchId: next.id,
                itemId: item.id,
                artifactId,
                sequence: artifactSequence,
                attachedAt: new Date(item.updatedAt),
              })),
              skipDuplicates: true,
            })
          }
        }
        const responseJson = stableSerialize({ batch: next })
        await transaction.v2ProductionBatchAction.create({
          data: {
            id: record.id,
            workspaceId: record.workspaceId,
            batchId: record.batchId,
            itemId: record.itemId,
            scope: record.scope,
            action: record.action,
            step: record.step,
            expectedBatchRevision: record.expectedBatchRevision,
            expectedItemRevision: record.expectedItemRevision,
            requestFingerprint: record.requestFingerprint,
            idempotencyKey: record.idempotencyKey,
            responseJson,
            retryManifestJson: partialRetry
              ? stableSerialize(partialRetry)
              : null,
            retryManifestHash: partialRetry?.retryHash ?? null,
            actorClientId: record.actorClientId,
            ...batchActorAuditData(
              record.authenticationAudit,
              record.workspaceId,
              record.actorClientId,
            ),
            createdAt: new Date(record.createdAt),
          },
        })
        if (partialRetry) {
          await transaction.v2ProductionBatchRetryJob.createMany({
            data: partialRetry.jobs.map((job) => ({
              id: job.id,
              workspaceId: job.workspaceId,
              projectId: job.projectId,
              batchId: job.batchId,
              itemId: job.itemId,
              actionId: job.retryId,
              schemaVersion: job.schemaVersion,
              step: job.step,
              executorClass: job.executorClass,
              status: job.status,
              lineageKey: job.lineageKey,
              failedAttempt: job.failedAttempt,
              retryAttempt: job.retryAttempt,
              previousStepHash: job.previousStepHash,
              queuedStepHash: job.queuedStepHash,
              failureCode: job.failureCode,
              failureMessage: job.failureMessage,
              preservedArtifactIdsJson: stableSerialize(
                job.preservedArtifactIds,
              ),
              preservedArtifactCount: job.preservedArtifactCount,
              chargedMinorUnitsAtEnqueue:
                job.chargedMinorUnitsAtEnqueue,
              createdAt: new Date(job.createdAt),
              jobHash: job.jobHash,
            })),
          })
        }
        const persisted =
          await transaction.v2ProductionBatch.findUniqueOrThrow({
            where: { id: next.id },
            include: batchInclude,
          })
        return Object.freeze({
          batch: hydrateBatch(persisted),
          replayed: false,
          ...(partialRetry ? { partialRetry } : {}),
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistAction(record, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = record.action === 'partial-retry'
          ? await this.findPartialRetryReplay({
              workspaceId: record.workspaceId,
              actorClientId: record.actorClientId,
              actorContextHash: record.authenticationAudit.contextHash,
              idempotencyKey: record.idempotencyKey,
            })
          : await this.findActionReplay({
              workspaceId: record.workspaceId,
              actorClientId: record.actorClientId,
              actorContextHash: record.authenticationAudit.contextHash,
              idempotencyKey: record.idempotencyKey,
            })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different production batch action',
            )
          }
          if (record.action === 'partial-retry') {
            return Object.freeze({
              batch: replay.batch,
              replayed: true,
              partialRetry: (
                replay as Readonly<ProductionBatchPartialRetryReplay>
              ).partialRetry,
            })
          }
          return Object.freeze({
            batch: replay.batch,
            replayed: true,
          })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Production batch action conflicted with another transaction',
        )
      }
      throw error
    }
  }
}
