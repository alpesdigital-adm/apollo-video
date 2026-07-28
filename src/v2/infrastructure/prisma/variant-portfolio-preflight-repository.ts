import {
  Prisma,
  type PrismaClient,
  type V2VariantPortfolioPolicy,
  type V2VariantPortfolioPreflightRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  VariantPortfolioPreflightCreateRecord,
  VariantPortfolioPreflightPage,
  VariantPortfolioPreflightReplay,
  VariantPortfolioPreflightRepository,
} from '../../application/ports/variant-portfolio-preflight-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import type {
  ProductionBatchVariant,
} from '../../domain/production-batch.ts'
import {
  hydrateVariantPortfolioPolicy,
  hydrateVariantPortfolioPreflight,
  type VariantPortfolioPolicy,
  type VariantPortfolioPreflightRun,
} from '../../domain/variant-portfolio-preflight.ts'
import {
  hydrateVariantRecipe,
  type VariantRecipeRun,
} from '../../domain/variant-recipe.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  hydrateCompatibilityGraphRow,
} from './compatibility-graph-repository.ts'

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

export function hydrateVariantPortfolioPolicyRow(
  row: V2VariantPortfolioPolicy,
): Readonly<VariantPortfolioPolicy> {
  const policy = hydrateVariantPortfolioPolicy(
    canonicalJson<VariantPortfolioPolicy>(
      row.policyJson,
      'variant portfolio policy',
    ),
  )
  if (
    policy.workspaceId !== row.workspaceId ||
    policy.schemaVersion !== row.schemaVersion ||
    policy.revision !== row.revision ||
    policy.defaultRecipeLimit !== row.defaultRecipeLimit ||
    policy.maxRecipeLimit !== row.maxRecipeLimit ||
    policy.maxOutputCount !== row.maxOutputCount ||
    policy.minCompatibilityEdgeScore !==
      Number(row.minCompatibilityEdgeScore) ||
    policy.minRecipeScore !== Number(row.minRecipeScore) ||
    policy.minHookCoverage !== row.minHookCoverage ||
    policy.minBodyCoverage !== row.minBodyCoverage ||
    policy.minCtaCoverage !== row.minCtaCoverage ||
    policy.maxRecipesPerSemanticCluster !==
      row.maxRecipesPerSemanticCluster ||
    policy.maxCandidateScanCount !== row.maxCandidateScanCount ||
    policy.estimatedCostPerOutputMinorUnits !==
      row.estimatedCostPerOutputMinorUnits ||
    policy.estimatedDurationSecondsPerOutput !==
      row.estimatedDurationSecondsPerOutput ||
    policy.estimatedStorageBytesPerOutput !==
      Number(row.estimatedStorageBytesPerOutput) ||
    policy.maxConcurrentJobs !== row.maxConcurrentJobs ||
    policy.confirmationTtlSeconds !== row.confirmationTtlSeconds ||
    policy.policyHash !== row.policyHash ||
    policy.updatedByClientId !== row.updatedByClientId ||
    policy.updatedAt !== row.updatedAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored variant portfolio policy revision ${row.revision} is inconsistent`,
    )
  }
  return policy
}

export function hydrateVariantPortfolioPreflightRow(
  row: V2VariantPortfolioPreflightRun,
): Readonly<VariantPortfolioPreflightRun> {
  const run = hydrateVariantPortfolioPreflight(
    canonicalJson<VariantPortfolioPreflightRun>(
      row.resultJson,
      'variant portfolio preflight result',
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.compatibilityGraphId !== row.compatibilityGraphId ||
    run.compatibilityGraphRunHash !==
      row.compatibilityGraphRunHash ||
    run.takeLibraryId !== row.takeLibraryId ||
    run.schemaVersion !== row.schemaVersion ||
    run.selectionVersion !== row.selectionVersion ||
    run.objective !== row.objective ||
    run.status !== row.status ||
    run.policy.policyHash !== row.policyHash ||
    run.requestedRecipeCount !== row.requestedRecipeCount ||
    run.effectiveRecipeLimit !== row.effectiveRecipeLimit ||
    run.batchVariantCount !== row.batchVariantCount ||
    run.budgetRemainingMinorUnits !==
      row.budgetRemainingMinorUnits ||
    run.theoreticalCandidateCount !==
      row.theoreticalCandidateCount.toFixed(0) ||
    run.eligibleCandidateCount !==
      row.eligibleCandidateCount.toFixed(0) ||
    run.scannedCandidateCount !== row.scannedCandidateCount ||
    run.selectedRecipeCount !== row.selectedRecipeCount ||
    run.estimates.outputVariantCount !== row.outputVariantCount ||
    run.estimates.plannedJobCount !== row.plannedJobCount ||
    run.estimates.jobsCreated !== row.jobsCreated ||
    run.estimates.estimatedCostMinorUnits !==
      row.estimatedCostMinorUnits ||
    run.estimates.estimatedDurationSeconds !==
      row.estimatedDurationSeconds ||
    run.estimates.estimatedStorageBytes !==
      Number(row.estimatedStorageBytes) ||
    run.estimates.reusedRecipeCount !== row.reusedRecipeCount ||
    run.productMaterialized !== row.productMaterialized ||
    run.confirmation.required !== row.confirmationRequired ||
    run.confirmation.satisfied !== row.confirmationSatisfied ||
    (run.confirmation.expiresAt ?? null) !==
      (row.confirmationExpiresAt?.toISOString() ?? null) ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored variant portfolio preflight ${row.id} has inconsistent projections`,
    )
  }
  return run
}

function policyData(policy: Readonly<VariantPortfolioPolicy>) {
  return {
    workspaceId: policy.workspaceId,
    schemaVersion: policy.schemaVersion,
    revision: policy.revision,
    defaultRecipeLimit: policy.defaultRecipeLimit,
    maxRecipeLimit: policy.maxRecipeLimit,
    maxOutputCount: policy.maxOutputCount,
    minCompatibilityEdgeScore: policy.minCompatibilityEdgeScore,
    minRecipeScore: policy.minRecipeScore,
    minHookCoverage: policy.minHookCoverage,
    minBodyCoverage: policy.minBodyCoverage,
    minCtaCoverage: policy.minCtaCoverage,
    maxRecipesPerSemanticCluster:
      policy.maxRecipesPerSemanticCluster,
    maxCandidateScanCount: policy.maxCandidateScanCount,
    estimatedCostPerOutputMinorUnits:
      policy.estimatedCostPerOutputMinorUnits,
    estimatedDurationSecondsPerOutput:
      policy.estimatedDurationSecondsPerOutput,
    estimatedStorageBytesPerOutput:
      BigInt(policy.estimatedStorageBytesPerOutput),
    maxConcurrentJobs: policy.maxConcurrentJobs,
    confirmationTtlSeconds: policy.confirmationTtlSeconds,
    policyJson: stableSerialize(policy),
    policyHash: policy.policyHash,
    updatedByClientId: policy.updatedByClientId,
    createdAt: new Date(policy.updatedAt),
    updatedAt: new Date(policy.updatedAt),
  }
}

function runData(
  record: Readonly<VariantPortfolioPreflightCreateRecord>,
) {
  const { run } = record
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    compatibilityGraphId: run.compatibilityGraphId,
    compatibilityGraphRunHash: run.compatibilityGraphRunHash,
    takeLibraryId: run.takeLibraryId,
    schemaVersion: run.schemaVersion,
    selectionVersion: run.selectionVersion,
    objective: run.objective,
    status: run.status,
    resultJson: stableSerialize(run),
    policyHash: run.policy.policyHash,
    requestedRecipeCount: run.requestedRecipeCount,
    effectiveRecipeLimit: run.effectiveRecipeLimit,
    batchVariantCount: run.batchVariantCount,
    budgetRemainingMinorUnits: run.budgetRemainingMinorUnits,
    theoreticalCandidateCount: new Prisma.Decimal(
      run.theoreticalCandidateCount,
    ),
    eligibleCandidateCount: new Prisma.Decimal(
      run.eligibleCandidateCount,
    ),
    scannedCandidateCount: run.scannedCandidateCount,
    selectedRecipeCount: run.selectedRecipeCount,
    outputVariantCount: run.estimates.outputVariantCount,
    plannedJobCount: run.estimates.plannedJobCount,
    jobsCreated: run.estimates.jobsCreated,
    estimatedCostMinorUnits: run.estimates.estimatedCostMinorUnits,
    estimatedDurationSeconds:
      run.estimates.estimatedDurationSeconds,
    estimatedStorageBytes: BigInt(
      run.estimates.estimatedStorageBytes,
    ),
    reusedRecipeCount: run.estimates.reusedRecipeCount,
    productMaterialized: run.productMaterialized,
    confirmationRequired: run.confirmation.required,
    confirmationSatisfied: run.confirmation.satisfied,
    confirmationExpiresAt: run.confirmation.expiresAt
      ? new Date(run.confirmation.expiresAt)
      : null,
    runHash: run.runHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: run.createdByClientId,
    createdAt: new Date(run.createdAt),
  }
}

async function assertCreationContext(
  transaction: Prisma.TransactionClient,
  run: Readonly<VariantPortfolioPreflightRun>,
) {
  const [batch, graph, policy, actor] = await Promise.all([
    transaction.v2ProductionBatch.findFirst({
      where: {
        id: run.batchId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
      },
      select: {
        objective: true,
        variantsJson: true,
        maxCostMinorUnits: true,
        reservedCostMinorUnits: true,
      },
    }),
    transaction.v2CompatibilityGraphRun.findFirst({
      where: {
        id: run.compatibilityGraphId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        batchId: run.batchId,
        takeLibraryId: run.takeLibraryId,
      },
      select: { runHash: true },
    }),
    transaction.v2VariantPortfolioPolicy.findUnique({
      where: {
        workspaceId_policyHash: {
          workspaceId: run.workspaceId,
          policyHash: run.policy.policyHash,
        },
      },
      select: { policyHash: true },
    }),
    transaction.v2ApiClient.findFirst({
      where: {
        id: run.createdByClientId,
        workspaceId: run.workspaceId,
        status: 'active',
      },
      select: { id: true },
    }),
  ])
  if (!batch) {
    throw new DomainError(
      'PRODUCTION_BATCH_NOT_FOUND',
      'Variant portfolio production batch was not found',
    )
  }
  const variants = canonicalJson<
    readonly Readonly<ProductionBatchVariant>[]
  >(batch.variantsJson, 'production batch variants')
  if (
    batch.objective !== run.objective ||
    variants.length !== run.batchVariantCount ||
    Math.max(
      0,
      batch.maxCostMinorUnits - batch.reservedCostMinorUnits,
    ) !== run.budgetRemainingMinorUnits
  ) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Production batch changed before preflight persistence',
    )
  }
  if (!graph || graph.runHash !== run.compatibilityGraphRunHash) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Compatibility graph changed before preflight persistence',
    )
  }
  if (!policy) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Workspace portfolio policy changed before preflight persistence',
    )
  }
  if (!actor) {
    throw new DomainError(
      'API_CLIENT_NOT_FOUND',
      'Variant portfolio preflight actor was not found or is inactive',
    )
  }
}

export class PrismaVariantPortfolioPreflightRepository
implements VariantPortfolioPreflightRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async loadCreationContext(input: {
    workspaceId: string
    batchId: string
    compatibilityGraphId: string
    expectedCompatibilityGraphRunHash: string
    actorClientId: string
  }) {
    const [graph, batch, actor, recipeRows] = await Promise.all([
      this.prisma.v2CompatibilityGraphRun.findFirst({
        where: {
          id: input.compatibilityGraphId,
          workspaceId: input.workspaceId,
          batchId: input.batchId,
        },
        include: { nodes: true, edges: true },
      }),
      this.prisma.v2ProductionBatch.findFirst({
        where: {
          id: input.batchId,
          workspaceId: input.workspaceId,
        },
        select: {
          projectId: true,
          objective: true,
          variantsJson: true,
          maxCostMinorUnits: true,
          reservedCostMinorUnits: true,
        },
      }),
      this.prisma.v2ApiClient.findFirst({
        where: {
          id: input.actorClientId,
          workspaceId: input.workspaceId,
          status: 'active',
        },
        select: { id: true },
      }),
      this.prisma.v2VariantRecipeRun.findMany({
        where: {
          workspaceId: input.workspaceId,
          batchId: input.batchId,
          compatibilityGraphId: input.compatibilityGraphId,
        },
        select: { resultJson: true },
        orderBy: [{ totalScore: 'desc' }, { id: 'asc' }],
        take: 1_000,
      }),
    ])
    if (!batch) {
      throw new DomainError(
        'PRODUCTION_BATCH_NOT_FOUND',
        'Variant portfolio production batch was not found',
      )
    }
    if (!graph || graph.projectId !== batch.projectId) {
      throw new DomainError(
        'COMPATIBILITY_GRAPH_NOT_FOUND',
        'Variant portfolio compatibility graph was not found',
      )
    }
    if (graph.runHash !== input.expectedCompatibilityGraphRunHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Compatibility graph hash is stale',
      )
    }
    if (!actor) {
      throw new DomainError(
        'API_CLIENT_NOT_FOUND',
        'Variant portfolio preflight actor was not found or is inactive',
      )
    }
    const variants = canonicalJson<
      readonly Readonly<ProductionBatchVariant>[]
    >(batch.variantsJson, 'production batch variants')
    const recipes = recipeRows.map((row) =>
      hydrateVariantRecipe(
        canonicalJson<VariantRecipeRun>(
          row.resultJson,
          'variant recipe result',
        ),
      ))
    return Object.freeze({
      projectId: batch.projectId,
      objective: batch.objective,
      compatibilityGraph: hydrateCompatibilityGraphRow(graph),
      batchVariantCount: variants.length,
      budgetRemainingMinorUnits: Math.max(
        0,
        batch.maxCostMinorUnits - batch.reservedCostMinorUnits,
      ),
      existingRecipes: Object.freeze(recipes.map((recipe) =>
        Object.freeze({
          recipeId: recipe.id,
          orderedNodeIds: recipe.orderedNodeIds,
          runHash: recipe.runHash,
        }))),
    })
  }

  async readPolicy(input: { workspaceId: string }) {
    const row = await this.prisma.v2VariantPortfolioPolicy.findFirst({
      where: { workspaceId: input.workspaceId },
      orderBy: { revision: 'desc' },
    })
    return row ? hydrateVariantPortfolioPolicyRow(row) : null
  }

  async ensurePolicy(
    policy: Readonly<VariantPortfolioPolicy>,
  ): Promise<Readonly<VariantPortfolioPolicy>> {
    const current = await this.readPolicy({
      workspaceId: policy.workspaceId,
    })
    if (current) return current
    try {
      const row = await this.prisma.v2VariantPortfolioPolicy.create({
        data: policyData(policy),
      })
      return hydrateVariantPortfolioPolicyRow(row)
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

  async findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<VariantPortfolioPreflightReplay> | null> {
    const row =
      await this.prisma.v2VariantPortfolioPreflightRun.findFirst({
        where: {
          workspaceId: input.workspaceId,
          createdByClientId: input.actorClientId,
          idempotencyKey: input.idempotencyKey,
        },
      })
    return row
      ? Object.freeze({
          run: hydrateVariantPortfolioPreflightRow(row),
          requestFingerprint: row.requestFingerprint,
        })
      : null
  }

  async create(
    record: Readonly<VariantPortfolioPreflightCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<VariantPortfolioPreflightRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2VariantPortfolioPreflightRun.findFirst({
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
              'Idempotency key was used with a different variant portfolio preflight request',
            )
          }
          return Object.freeze({
            run: hydrateVariantPortfolioPreflightRow(replay),
            replayed: true,
          })
        }
        await assertCreationContext(transaction, record.run)
        const persisted =
          await transaction.v2VariantPortfolioPreflightRun.create({
            data: runData(record),
          })
        return Object.freeze({
          run: hydrateVariantPortfolioPreflightRow(persisted),
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
              'Idempotency key was used with a different variant portfolio preflight request',
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
          'Variant portfolio preflight conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }) {
    const row =
      await this.prisma.v2VariantPortfolioPreflightRun.findFirst({
        where: {
          id: input.runId,
          workspaceId: input.workspaceId,
          batchId: input.batchId,
        },
      })
    return row ? hydrateVariantPortfolioPreflightRow(row) : null
  }

  async list(input: {
    workspaceId: string
    batchId: string
    compatibilityGraphId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<VariantPortfolioPreflightPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2VariantPortfolioPreflightRun.findFirst({
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
        'Variant portfolio preflight cursor is invalid',
      )
    }
    const rows =
      await this.prisma.v2VariantPortfolioPreflightRun.findMany({
        where: {
          workspaceId: input.workspaceId,
          batchId: input.batchId,
          ...(input.compatibilityGraphId
            ? {
                compatibilityGraphId:
                  input.compatibilityGraphId,
              }
            : {}),
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
      runs: Object.freeze(
        page.map(hydrateVariantPortfolioPreflightRow),
      ),
      ...(hasMore && page.at(-1)
        ? { nextCursor: page.at(-1)!.id }
        : {}),
    })
  }
}
