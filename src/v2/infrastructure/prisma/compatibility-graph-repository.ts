import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  CompatibilityGraphCreateRecord,
  CompatibilityGraphPage,
  CompatibilityGraphReplay,
  CompatibilityGraphRepository,
} from '../../application/ports/compatibility-graph-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import {
  hydrateCompatibilityGraph,
  type CompatibilityEdge,
  type CompatibilityGraphRun,
  type CompatibilityNode,
} from '../../domain/compatibility-graph.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  hydrateTakeLibraryRow,
} from './take-library-repository.ts'
import {
  batchActorAuditData,
  hydrateBatchActorAudit,
} from './batch-actor-audit.ts'

export type CompatibilityGraphPrismaRow =
Prisma.V2CompatibilityGraphRunGetPayload<{
  include: { nodes: true; edges: true }
}>

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
}

function canonicalJson<T>(value: string, field: string): Readonly<T> {
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

export function hydrateCompatibilityGraphRow(
  row: CompatibilityGraphPrismaRow,
): Readonly<CompatibilityGraphRun> {
  hydrateBatchActorAudit(row, row.createdByClientId)
  const run = hydrateCompatibilityGraph(
    canonicalJson<CompatibilityGraphRun>(
      row.resultJson,
      'compatibility graph result',
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.takeLibraryId !== row.takeLibraryId ||
    run.takeLibraryRunHash !== row.takeLibraryRunHash ||
    run.schemaVersion !== row.schemaVersion ||
    run.ruleVersion !== row.ruleVersion ||
    run.softScoreVersion !== row.softScoreVersion ||
    run.acceptThreshold !== Number(row.acceptThreshold) ||
    run.reviewThreshold !== Number(row.reviewThreshold) ||
    run.summary.nodeCount !== row.nodeCount ||
    run.summary.edgeCount !== row.edgeCount ||
    run.summary.acceptedCount !== row.acceptedCount ||
    run.summary.borderlineCount !== row.borderlineCount ||
    run.summary.blockedCount !== row.blockedCount ||
    run.summary.hardFailureCount !== row.hardFailureCount ||
    run.summary.averageSoftScore !== Number(row.averageSoftScore) ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored compatibility graph ${row.id} has inconsistent projections`,
    )
  }
  if (
    row.nodes.length !== run.nodes.length ||
    row.edges.length !== run.edges.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored compatibility graph ${row.id} has incomplete rows`,
    )
  }
  const nodes = new Map(run.nodes.map((node) => [node.id, node]))
  for (const rowNode of row.nodes) {
    const node = nodes.get(rowNode.id)
    const stored = canonicalJson<CompatibilityNode>(
      rowNode.nodeJson,
      `compatibility node ${rowNode.id}`,
    )
    if (
      !node ||
      stableSerialize(stored) !== stableSerialize(node) ||
      rowNode.workspaceId !== run.workspaceId ||
      rowNode.graphId !== run.id ||
      rowNode.takeId !== node.takeId ||
      rowNode.groupId !== node.groupId ||
      rowNode.scriptBlockId !== (node.scriptBlockId ?? null) ||
      rowNode.role !== node.role ||
      rowNode.sourceArtifactId !== node.sourceArtifactId ||
      rowNode.sourceHash !== node.sourceHash ||
      rowNode.contextHash !== node.contextHash ||
      rowNode.nodeHash !== node.nodeHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored compatibility node ${rowNode.id} is inconsistent`,
      )
    }
  }
  const edges = new Map(run.edges.map((edge) => [edge.id, edge]))
  for (const rowEdge of row.edges) {
    const edge = edges.get(rowEdge.id)
    const stored = canonicalJson<CompatibilityEdge>(
      rowEdge.edgeJson,
      `compatibility edge ${rowEdge.id}`,
    )
    if (
      !edge ||
      stableSerialize(stored) !== stableSerialize(edge) ||
      rowEdge.workspaceId !== run.workspaceId ||
      rowEdge.graphId !== run.id ||
      rowEdge.fromNodeId !== edge.fromNodeId ||
      rowEdge.toNodeId !== edge.toNodeId ||
      rowEdge.relation !== edge.relation ||
      rowEdge.decision !== edge.decision ||
      rowEdge.eligible !== edge.eligible ||
      Number(rowEdge.softScore) !== edge.softScore ||
      rowEdge.reasonCodesJson !== stableSerialize(edge.reasonCodes) ||
      rowEdge.evidenceJson !== stableSerialize(edge.evidence) ||
      rowEdge.edgeHash !== edge.edgeHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored compatibility edge ${rowEdge.id} is inconsistent`,
      )
    }
  }
  return run
}

function runData(record: Readonly<CompatibilityGraphCreateRecord>) {
  const { run } = record
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    takeLibraryId: run.takeLibraryId,
    takeLibraryRunHash: run.takeLibraryRunHash,
    schemaVersion: run.schemaVersion,
    ruleVersion: run.ruleVersion,
    softScoreVersion: run.softScoreVersion,
    acceptThreshold: run.acceptThreshold,
    reviewThreshold: run.reviewThreshold,
    resultJson: stableSerialize(run),
    nodeCount: run.summary.nodeCount,
    edgeCount: run.summary.edgeCount,
    acceptedCount: run.summary.acceptedCount,
    borderlineCount: run.summary.borderlineCount,
    blockedCount: run.summary.blockedCount,
    hardFailureCount: run.summary.hardFailureCount,
    averageSoftScore: run.summary.averageSoftScore,
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

function nodeData(
  run: Readonly<CompatibilityGraphRun>,
  node: Readonly<CompatibilityNode>,
) {
  return {
    id: node.id,
    workspaceId: run.workspaceId,
    graphId: run.id,
    takeId: node.takeId,
    groupId: node.groupId,
    ...(node.scriptBlockId
      ? { scriptBlockId: node.scriptBlockId }
      : {}),
    role: node.role,
    sourceArtifactId: node.sourceArtifactId,
    sourceHash: node.sourceHash,
    contextHash: node.contextHash,
    nodeJson: stableSerialize(node),
    nodeHash: node.nodeHash,
  }
}

function edgeData(
  run: Readonly<CompatibilityGraphRun>,
  edge: Readonly<CompatibilityEdge>,
) {
  return {
    id: edge.id,
    workspaceId: run.workspaceId,
    graphId: run.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    relation: edge.relation,
    decision: edge.decision,
    eligible: edge.eligible,
    softScore: edge.softScore,
    reasonCodesJson: stableSerialize(edge.reasonCodes),
    evidenceJson: stableSerialize(edge.evidence),
    edgeJson: stableSerialize(edge),
    edgeHash: edge.edgeHash,
  }
}

async function assertCreationContext(
  transaction: Prisma.TransactionClient,
  run: Readonly<CompatibilityGraphRun>,
) {
  const [batch, library, actor] = await Promise.all([
    transaction.v2ProductionBatch.findFirst({
      where: {
        id: run.batchId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
      },
      select: { id: true },
    }),
    transaction.v2TakeLibraryRun.findFirst({
      where: {
        id: run.takeLibraryId,
        workspaceId: run.workspaceId,
        batchId: run.batchId,
        projectId: run.projectId,
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
      'Compatibility graph production batch was not found',
    )
  }
  if (!library) {
    throw new DomainError(
      'TAKE_LIBRARY_NOT_FOUND',
      'Compatibility graph take library was not found',
    )
  }
  if (library.runHash !== run.takeLibraryRunHash) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Take library changed before compatibility graph persistence',
    )
  }
  if (!actor) {
    throw new DomainError(
      'API_CLIENT_NOT_FOUND',
      'Compatibility graph actor was not found or is inactive',
    )
  }
}

export class PrismaCompatibilityGraphRepository
implements CompatibilityGraphRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async loadCreationContext(input: {
    workspaceId: string
    batchId: string
    takeLibraryId: string
    expectedTakeLibraryRunHash: string
    actorClientId: string
  }) {
    const [library, actor] = await Promise.all([
      this.prisma.v2TakeLibraryRun.findFirst({
        where: {
          id: input.takeLibraryId,
          workspaceId: input.workspaceId,
          batchId: input.batchId,
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
    ])
    if (!library) {
      throw new DomainError(
        'TAKE_LIBRARY_NOT_FOUND',
        'Compatibility graph take library was not found',
      )
    }
    if (!actor) {
      throw new DomainError(
        'API_CLIENT_NOT_FOUND',
        'Compatibility graph actor was not found or is inactive',
      )
    }
    if (library.runHash !== input.expectedTakeLibraryRunHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Take library hash is stale',
      )
    }
    return Object.freeze({
      projectId: library.projectId,
      takeLibrary: hydrateTakeLibraryRow(library),
    })
  }

  async findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<CompatibilityGraphReplay> | null> {
    const row = await this.prisma.v2CompatibilityGraphRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      include: { nodes: true, edges: true },
    })
    if (row) {
      if (hydrateBatchActorAudit(row, row.createdByClientId).contextHash !== input.actorContextHash) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
      }
      return Object.freeze({
          run: hydrateCompatibilityGraphRow(row),
          requestFingerprint: row.requestFingerprint,
        })
    }
    return null
  }

  async create(
    record: Readonly<CompatibilityGraphCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<CompatibilityGraphRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2CompatibilityGraphRun
          .findFirst({
            where: {
              workspaceId: record.run.workspaceId,
              createdByClientId: record.run.createdByClientId,
              idempotencyKey: record.idempotencyKey,
            },
            include: { nodes: true, edges: true },
          })
        if (replay) {
          if (
            hydrateBatchActorAudit(replay, replay.createdByClientId).contextHash !==
              record.authenticationAudit.contextHash
          ) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
          }
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different compatibility graph request',
            )
          }
          return Object.freeze({
            run: hydrateCompatibilityGraphRow(replay),
            replayed: true,
          })
        }
        await assertCreationContext(transaction, record.run)
        await transaction.v2CompatibilityGraphRun.create({
          data: runData(record),
        })
        await transaction.v2CompatibilityGraphNode.createMany({
          data: record.run.nodes.map((node) =>
            nodeData(record.run, node)),
        })
        await transaction.v2CompatibilityGraphEdge.createMany({
          data: record.run.edges.map((edge) =>
            edgeData(record.run, edge)),
        })
        const persisted = await transaction.v2CompatibilityGraphRun
          .findUniqueOrThrow({
            where: { id: record.run.id },
            include: { nodes: true, edges: true },
          })
        return Object.freeze({
          run: hydrateCompatibilityGraphRow(persisted),
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
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different compatibility graph request',
            )
          }
          return Object.freeze({ run: replay.run, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Compatibility graph creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<CompatibilityGraphRun> | null> {
    const row = await this.prisma.v2CompatibilityGraphRun.findFirst({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
      },
      include: { nodes: true, edges: true },
    })
    return row ? hydrateCompatibilityGraphRow(row) : null
  }

  async list(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<CompatibilityGraphPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2CompatibilityGraphRun.findFirst({
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
        'Compatibility graph cursor is invalid',
      )
    }
    const rows = await this.prisma.v2CompatibilityGraphRun.findMany({
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
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
      include: { nodes: true, edges: true },
    })
    const hasNextPage = rows.length > input.limit
    const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows
    const runs = Object.freeze(
      pageRows.map(hydrateCompatibilityGraphRow),
    )
    return Object.freeze({
      runs,
      ...(hasNextPage && runs.length > 0
        ? { nextCursor: runs.at(-1)!.id }
        : {}),
    })
  }
}
