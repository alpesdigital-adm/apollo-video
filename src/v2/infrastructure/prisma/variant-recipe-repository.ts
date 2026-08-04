import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  VariantRecipeCreateRecord,
  VariantRecipePage,
  VariantRecipeReplay,
  VariantRecipeRepository,
} from '../../application/ports/variant-recipe-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateVariantRecipe,
  type VariantRecipeLineageEntry,
  type VariantRecipeRun,
} from '../../domain/variant-recipe.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  hydrateCompatibilityGraphRow,
} from './compatibility-graph-repository.ts'
import { batchActorAuditData, hydrateBatchActorAudit } from './batch-actor-audit.ts'

type RecipeRow = Prisma.V2VariantRecipeRunGetPayload<{
  include: { lineage: true }
}>

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

export function hydrateVariantRecipeRow(
  row: RecipeRow,
): Readonly<VariantRecipeRun> {
  hydrateBatchActorAudit(row, row.createdByClientId)
  const run = hydrateVariantRecipe(
    canonicalJson<VariantRecipeRun>(
      row.resultJson,
      'variant recipe result',
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
    run.policyVersion !== row.policyVersion ||
    run.scoreVersion !== row.scoreVersion ||
    run.compilerVersion !== row.compilerVersion ||
    run.objective !== row.objective ||
    run.status !== row.status ||
    run.summary.selectedTakeCount !== row.selectedTakeCount ||
    run.summary.sourceSegmentCount !== row.sourceSegmentCount ||
    run.summary.lineageCount !== row.lineageCount ||
    run.summary.compatibilityEdgeCount !==
      row.compatibilityEdgeCount ||
    run.assumptions.length !== row.assumptionCount ||
    run.summary.estimatedDurationMs !== row.estimatedDurationMs ||
    run.summary.estimatedDurationFrames !==
      row.estimatedDurationFrames ||
    run.summary.includesProof !== row.includesProof ||
    run.summary.hasColdOpen !== row.hasColdOpen ||
    run.summary.masterReferenceCount !== row.masterReferenceCount ||
    run.scores.minimumEdgeScore !== Number(row.minimumEdgeScore) ||
    run.scores.averageEdgeScore !== Number(row.averageEdgeScore) ||
    run.scores.objectiveScore !== Number(row.objectiveScore) ||
    run.scores.totalScore !== Number(row.totalScore) ||
    run.proofPolicy.policyHash !== row.proofPolicyHash ||
    run.scores.scoresHash !== row.scoresHash ||
    run.storyPlan.storyHash !== row.storyPlanHash ||
    run.editPlan.editPlanHash !== row.editPlanHash ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored variant recipe ${row.id} has inconsistent projections`,
    )
  }
  if (row.lineage.length !== run.lineage.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored variant recipe ${row.id} has incomplete lineage`,
    )
  }
  const entries = new Map(run.lineage.map((entry) => [
    entry.id,
    entry,
  ]))
  for (const rowEntry of row.lineage) {
    const entry = entries.get(rowEntry.id)
    const stored = canonicalJson<VariantRecipeLineageEntry>(
      rowEntry.lineageJson,
      `variant recipe lineage ${rowEntry.id}`,
    )
    if (
      !entry ||
      stableSerialize(stored) !== stableSerialize(entry) ||
      rowEntry.workspaceId !== run.workspaceId ||
      rowEntry.recipeId !== run.id ||
      rowEntry.compatibilityGraphId !== run.compatibilityGraphId ||
      rowEntry.sequence !== entry.sequence ||
      rowEntry.usage !== entry.usage ||
      rowEntry.role !== entry.role ||
      rowEntry.nodeId !== entry.nodeId ||
      rowEntry.takeId !== entry.takeId ||
      rowEntry.takeHash !== entry.takeHash ||
      rowEntry.scriptBlockId !== entry.scriptBlockId ||
      rowEntry.groupId !== entry.groupId ||
      rowEntry.sourceSegmentId !== entry.sourceSegmentId ||
      rowEntry.sourceArtifactId !== entry.sourceArtifactId ||
      rowEntry.sourceHash !== entry.sourceHash ||
      Number(rowEntry.sourceRangeStartMs) !==
        entry.sourceRangeMs[0] ||
      Number(rowEntry.sourceRangeEndMs) !==
        entry.sourceRangeMs[1] ||
      rowEntry.lineageHash !== entry.lineageHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored variant recipe lineage ${rowEntry.id} is inconsistent`,
      )
    }
  }
  return run
}

function runData(record: Readonly<VariantRecipeCreateRecord>) {
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
    policyVersion: run.policyVersion,
    scoreVersion: run.scoreVersion,
    compilerVersion: run.compilerVersion,
    objective: run.objective,
    status: run.status,
    resultJson: stableSerialize(run),
    selectedTakeCount: run.summary.selectedTakeCount,
    sourceSegmentCount: run.summary.sourceSegmentCount,
    lineageCount: run.summary.lineageCount,
    compatibilityEdgeCount: run.summary.compatibilityEdgeCount,
    assumptionCount: run.assumptions.length,
    estimatedDurationMs: run.summary.estimatedDurationMs,
    estimatedDurationFrames: run.summary.estimatedDurationFrames,
    includesProof: run.summary.includesProof,
    hasColdOpen: run.summary.hasColdOpen,
    masterReferenceCount: run.summary.masterReferenceCount,
    minimumEdgeScore: run.scores.minimumEdgeScore,
    averageEdgeScore: run.scores.averageEdgeScore,
    objectiveScore: run.scores.objectiveScore,
    totalScore: run.scores.totalScore,
    proofPolicyHash: run.proofPolicy.policyHash,
    scoresHash: run.scores.scoresHash,
    storyPlanHash: run.storyPlan.storyHash,
    editPlanHash: run.editPlan.editPlanHash,
    runHash: run.runHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: run.createdByClientId,
    ...batchActorAuditData(
      record.authenticationAudit,
      run.workspaceId,
      run.createdByClientId,
    ),
    createdAt: new Date(run.createdAt),
  }
}

function lineageData(
  run: Readonly<VariantRecipeRun>,
  entry: Readonly<VariantRecipeLineageEntry>,
) {
  return {
    id: entry.id,
    workspaceId: run.workspaceId,
    recipeId: run.id,
    compatibilityGraphId: run.compatibilityGraphId,
    sequence: entry.sequence,
    usage: entry.usage,
    role: entry.role,
    nodeId: entry.nodeId,
    takeId: entry.takeId,
    takeHash: entry.takeHash,
    scriptBlockId: entry.scriptBlockId,
    groupId: entry.groupId,
    sourceSegmentId: entry.sourceSegmentId,
    sourceArtifactId: entry.sourceArtifactId,
    sourceHash: entry.sourceHash,
    sourceRangeStartMs: entry.sourceRangeMs[0],
    sourceRangeEndMs: entry.sourceRangeMs[1],
    lineageJson: stableSerialize(entry),
    lineageHash: entry.lineageHash,
  }
}

async function assertCreationContext(
  transaction: Prisma.TransactionClient,
  run: Readonly<VariantRecipeRun>,
) {
  const [batch, graph, actor] = await Promise.all([
    transaction.v2ProductionBatch.findFirst({
      where: {
        id: run.batchId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
      },
      select: { objective: true },
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
      'Variant recipe production batch was not found',
    )
  }
  if (batch.objective !== run.objective) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Production batch objective changed before recipe persistence',
    )
  }
  if (!graph) {
    throw new DomainError(
      'COMPATIBILITY_GRAPH_NOT_FOUND',
      'Variant recipe compatibility graph was not found',
    )
  }
  if (graph.runHash !== run.compatibilityGraphRunHash) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Compatibility graph changed before recipe persistence',
    )
  }
  if (!actor) {
    throw new DomainError(
      'API_CLIENT_NOT_FOUND',
      'Variant recipe actor was not found or is inactive',
    )
  }
}

export class PrismaVariantRecipeRepository
implements VariantRecipeRepository {
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
    const [graph, batch, actor] = await Promise.all([
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
        select: { id: true, projectId: true, objective: true },
      }),
      this.prisma.v2ApiClient.findFirst({
        where: {
          id: input.actorClientId,
          workspaceId: input.workspaceId,
          status: 'active',
        },
        select: { id: true },
      }),
    ])
    if (!batch) {
      throw new DomainError(
        'PRODUCTION_BATCH_NOT_FOUND',
        'Variant recipe production batch was not found',
      )
    }
    if (!graph || graph.projectId !== batch.projectId) {
      throw new DomainError(
        'COMPATIBILITY_GRAPH_NOT_FOUND',
        'Variant recipe compatibility graph was not found',
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
        'Variant recipe actor was not found or is inactive',
      )
    }
    return Object.freeze({
      projectId: batch.projectId,
      objective: batch.objective,
      compatibilityGraph: hydrateCompatibilityGraphRow(graph),
    })
  }

  async findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<VariantRecipeReplay> | null> {
    const row = await this.prisma.v2VariantRecipeRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      include: { lineage: true },
    })
    if (row) {
      if (hydrateBatchActorAudit(row, row.createdByClientId).contextHash !== input.actorContextHash) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
      }
      return Object.freeze({
          run: hydrateVariantRecipeRow(row),
          requestFingerprint: row.requestFingerprint,
        })
    }
    return null
  }

  async create(
    record: Readonly<VariantRecipeCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<VariantRecipeRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2VariantRecipeRun.findFirst({
          where: {
            workspaceId: record.run.workspaceId,
            createdByClientId: record.run.createdByClientId,
            idempotencyKey: record.idempotencyKey,
          },
          include: { lineage: true },
        })
        if (replay) {
          if (hydrateBatchActorAudit(replay, replay.createdByClientId).contextHash !== record.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
          }
          if (
            replay.requestFingerprint !== record.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different variant recipe request',
            )
          }
          return Object.freeze({
            run: hydrateVariantRecipeRow(replay),
            replayed: true,
          })
        }
        await assertCreationContext(transaction, record.run)
        await transaction.v2VariantRecipeRun.create({
          data: runData(record),
        })
        await transaction.v2VariantRecipeLineage.createMany({
          data: record.run.lineage.map((entry) =>
            lineageData(record.run, entry)),
        })
        const persisted = await transaction.v2VariantRecipeRun
          .findUniqueOrThrow({
            where: { id: record.run.id },
            include: { lineage: true },
          })
        return Object.freeze({
          run: hydrateVariantRecipeRow(persisted),
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
          actorContextHash: record.authenticationAudit.contextHash,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (
            replay.requestFingerprint !== record.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different variant recipe request',
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
          'Variant recipe creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<VariantRecipeRun> | null> {
    const row = await this.prisma.v2VariantRecipeRun.findFirst({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
      },
      include: { lineage: true },
    })
    return row ? hydrateVariantRecipeRow(row) : null
  }

  async list(input: {
    workspaceId: string
    batchId: string
    compatibilityGraphId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<VariantRecipePage>> {
    const cursor = input.cursor
      ? await this.prisma.v2VariantRecipeRun.findFirst({
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
        'Variant recipe cursor is invalid',
      )
    }
    const rows = await this.prisma.v2VariantRecipeRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        ...(input.compatibilityGraphId
          ? { compatibilityGraphId: input.compatibilityGraphId }
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
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
      include: { lineage: true },
    })
    const hasNextPage = rows.length > input.limit
    const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows
    const runs = Object.freeze(pageRows.map(hydrateVariantRecipeRow))
    return Object.freeze({
      runs,
      ...(hasNextPage && runs.length > 0
        ? { nextCursor: runs.at(-1)!.id }
        : {}),
    })
  }
}
