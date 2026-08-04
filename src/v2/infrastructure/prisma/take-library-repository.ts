import {
  Prisma,
  type PrismaClient,
  type V2TakeLibraryRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  TakeLibraryCreateRecord,
  TakeLibraryPage,
  TakeLibraryReplay,
  TakeLibraryRepository,
  TakeLibrarySelectionRecord,
} from '../../application/ports/take-library-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateTakeLibraryRun,
  type TakeLibraryRun,
} from '../../domain/take-library.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { batchActorAuditData, hydrateBatchActorAudit } from './batch-actor-audit.ts'
import { hydrateRunRow as hydrateAlignmentRow } from './script-alignment-repository.ts'

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

function hydrateRunRow(
  row: V2TakeLibraryRun,
): Readonly<TakeLibraryRun> {
  hydrateBatchActorAudit(row, row.createdByClientId)
  const run = hydrateTakeLibraryRun(
    canonicalJson<TakeLibraryRun>(
      row.resultJson,
      'take library result',
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.alignmentId !== row.alignmentId ||
    run.alignmentRunHash !== row.alignmentRunHash ||
    run.schemaVersion !== row.schemaVersion ||
    run.groupingPolicyVersion !== row.groupingPolicyVersion ||
    run.evaluationPolicyVersion !== row.evaluationPolicyVersion ||
    run.status !== row.status ||
    run.revision !== row.revision ||
    run.summary.groupCount !== row.groupCount ||
    run.summary.takeCount !== row.takeCount ||
    run.summary.primaryCount !== row.primaryCount ||
    run.summary.alternateCount !== row.alternateCount ||
    run.summary.rejectedCount !== row.rejectedCount ||
    run.summary.needsReviewCount !== row.needsReviewCount ||
    run.summary.protectedCount !== row.protectedCount ||
    run.summary.measuredDimensionCount !== row.measuredDimensionCount ||
    run.summary.unavailableDimensionCount !==
      row.unavailableDimensionCount ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString() ||
    run.updatedAt !== row.updatedAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored take library ${row.id} has inconsistent projections`,
    )
  }
  return run
}

export { hydrateRunRow as hydrateTakeLibraryRow }

function runData(record: Readonly<TakeLibraryCreateRecord>) {
  const { run } = record
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    alignmentId: run.alignmentId,
    alignmentRunHash: run.alignmentRunHash,
    schemaVersion: run.schemaVersion,
    groupingPolicyVersion: run.groupingPolicyVersion,
    evaluationPolicyVersion: run.evaluationPolicyVersion,
    status: run.status,
    revision: run.revision,
    resultJson: stableSerialize(run),
    groupCount: run.summary.groupCount,
    takeCount: run.summary.takeCount,
    primaryCount: run.summary.primaryCount,
    alternateCount: run.summary.alternateCount,
    rejectedCount: run.summary.rejectedCount,
    needsReviewCount: run.summary.needsReviewCount,
    protectedCount: run.summary.protectedCount,
    measuredDimensionCount: run.summary.measuredDimensionCount,
    unavailableDimensionCount: run.summary.unavailableDimensionCount,
    runHash: run.runHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: run.createdByClientId,
    ...batchActorAuditData(record.authenticationAudit, run.workspaceId, run.createdByClientId),
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  }
}

async function assertCreationContext(
  transaction: Prisma.TransactionClient,
  run: Readonly<TakeLibraryRun>,
) {
  const [batch, alignment, actor] = await Promise.all([
    transaction.v2ProductionBatch.findFirst({
      where: {
        id: run.batchId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
      },
      select: { id: true },
    }),
    transaction.v2ScriptAlignmentRun.findFirst({
      where: {
        id: run.alignmentId,
        workspaceId: run.workspaceId,
        batchId: run.batchId,
        projectId: run.projectId,
      },
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
      'Take library production batch was not found',
    )
  }
  if (!alignment) {
    throw new DomainError(
      'SCRIPT_ALIGNMENT_NOT_FOUND',
      'Take library script alignment was not found',
    )
  }
  if (alignment.runHash !== run.alignmentRunHash) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Script alignment changed before take library persistence',
    )
  }
  if (!actor) {
    throw new DomainError(
      'API_CLIENT_NOT_FOUND',
      'Take library actor was not found or is inactive',
    )
  }
}

export class PrismaTakeLibraryRepository
implements TakeLibraryRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async loadCreationContext(input: {
    workspaceId: string
    batchId: string
    alignmentId: string
    expectedAlignmentRunHash: string
    actorClientId: string
  }) {
    const [alignment, actor] = await Promise.all([
      this.prisma.v2ScriptAlignmentRun.findFirst({
        where: {
          id: input.alignmentId,
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
    if (!alignment) {
      throw new DomainError(
        'SCRIPT_ALIGNMENT_NOT_FOUND',
        'Take library script alignment was not found',
      )
    }
    if (!actor) {
      throw new DomainError(
        'API_CLIENT_NOT_FOUND',
        'Take library actor was not found or is inactive',
      )
    }
    if (alignment.runHash !== input.expectedAlignmentRunHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Script alignment hash is stale',
      )
    }
    return Object.freeze({
      projectId: alignment.projectId,
      alignment: hydrateAlignmentRow(alignment),
    })
  }

  async findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<TakeLibraryReplay> | null> {
    const row = await this.prisma.v2TakeLibraryRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
    })
    if (row) {
      if (hydrateBatchActorAudit(row, row.createdByClientId).contextHash !== input.actorContextHash) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
      }
      return Object.freeze({
          run: hydrateRunRow(row),
          requestFingerprint: row.requestFingerprint,
        })
    }
    return null
  }

  async create(
    record: Readonly<TakeLibraryCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<TakeLibraryRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2TakeLibraryRun.findFirst({
          where: {
            workspaceId: record.run.workspaceId,
            createdByClientId: record.run.createdByClientId,
            idempotencyKey: record.idempotencyKey,
          },
        })
        if (replay) {
          if (hydrateBatchActorAudit(replay, replay.createdByClientId).contextHash !== record.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
          }
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different take library request',
            )
          }
          return Object.freeze({
            run: hydrateRunRow(replay),
            replayed: true,
          })
        }
        await assertCreationContext(transaction, record.run)
        const row = await transaction.v2TakeLibraryRun.create({
          data: runData(record),
        })
        return Object.freeze({
          run: hydrateRunRow(row),
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
              'Idempotency key was used with a different take library request',
            )
          }
          return Object.freeze({ run: replay.run, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Take library creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<TakeLibraryRun> | null> {
    const row = await this.prisma.v2TakeLibraryRun.findFirst({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
      },
    })
    return row ? hydrateRunRow(row) : null
  }

  async list(input: {
    workspaceId: string
    batchId: string
    limit: number
    cursor?: string
  }): Promise<Readonly<TakeLibraryPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2TakeLibraryRun.findFirst({
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
        'Take library cursor is invalid',
      )
    }
    const rows = await this.prisma.v2TakeLibraryRun.findMany({
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
    })
    const hasNextPage = rows.length > input.limit
    const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows
    const runs = Object.freeze(pageRows.map(hydrateRunRow))
    return Object.freeze({
      runs,
      ...(hasNextPage && runs.length > 0
        ? { nextCursor: runs.at(-1)!.id }
        : {}),
    })
  }

  async findSelectionReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<TakeLibraryReplay> | null> {
    const row = await this.prisma.v2TakeLibrarySelection.findFirst({
      where: {
        workspaceId: input.workspaceId,
        actorClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      select: {
        requestFingerprint: true,
        resultRunJson: true,
        resultRunHash: true,
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
    if (!row) return null
    if (hydrateBatchActorAudit(row, row.actorClientId).contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
    }
    const run = hydrateTakeLibraryRun(
      canonicalJson<TakeLibraryRun>(
        row.resultRunJson,
        'take library selection result',
      ),
    )
    if (run.runHash !== row.resultRunHash) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored take library selection result hash is inconsistent',
      )
    }
    return Object.freeze({
      run,
      requestFingerprint: row.requestFingerprint,
    })
  }

  async persistSelection(
    record: Readonly<TakeLibrarySelectionRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<TakeLibraryRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2TakeLibrarySelection.findFirst({
          where: {
            workspaceId: record.resultingRun.workspaceId,
            actorClientId: record.selection.actorClientId,
            idempotencyKey: record.idempotencyKey,
          },
          select: {
            requestFingerprint: true,
            resultRunJson: true,
            resultRunHash: true,
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
        if (replay) {
          if (hydrateBatchActorAudit(replay, replay.actorClientId).contextHash !== record.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to a different authentication context')
          }
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different take selection',
            )
          }
          const run = hydrateTakeLibraryRun(
            canonicalJson<TakeLibraryRun>(
              replay.resultRunJson,
              'take library selection result',
            ),
          )
          if (run.runHash !== replay.resultRunHash) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Stored take library selection result hash is inconsistent',
            )
          }
          return Object.freeze({ run, replayed: true })
        }
        const [currentRow, actor] = await Promise.all([
          transaction.v2TakeLibraryRun.findFirst({
            where: {
              id: record.previousRun.id,
              workspaceId: record.previousRun.workspaceId,
              batchId: record.previousRun.batchId,
            },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: record.selection.actorClientId,
              workspaceId: record.resultingRun.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!currentRow) {
          throw new DomainError(
            'TAKE_LIBRARY_NOT_FOUND',
            'Take library was not found',
          )
        }
        if (!actor) {
          throw new DomainError(
            'API_CLIENT_NOT_FOUND',
            'Take selection actor was not found or is inactive',
          )
        }
        const current = hydrateRunRow(currentRow)
        const next = hydrateTakeLibraryRun(record.resultingRun)
        if (
          current.runHash !== record.previousRun.runHash ||
          current.revision !== record.previousRun.revision ||
          next.revision !== current.revision + 1 ||
          next.id !== current.id ||
          next.workspaceId !== current.workspaceId ||
          next.projectId !== current.projectId ||
          next.batchId !== current.batchId ||
          next.alignmentId !== current.alignmentId ||
          next.alignmentRunHash !== current.alignmentRunHash ||
          next.createdAt !== current.createdAt ||
          record.selection.revision !== next.revision ||
          next.selections.at(-1)?.selectionHash !==
            record.selection.selectionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Take library changed before selection persistence',
          )
        }
        const update = await transaction.v2TakeLibraryRun.updateMany({
          where: {
            id: current.id,
            workspaceId: current.workspaceId,
            revision: current.revision,
            runHash: current.runHash,
          },
          data: {
            status: next.status,
            revision: next.revision,
            resultJson: stableSerialize(next),
            primaryCount: next.summary.primaryCount,
            alternateCount: next.summary.alternateCount,
            rejectedCount: next.summary.rejectedCount,
            needsReviewCount: next.summary.needsReviewCount,
            protectedCount: next.summary.protectedCount,
            measuredDimensionCount: next.summary.measuredDimensionCount,
            unavailableDimensionCount:
              next.summary.unavailableDimensionCount,
            runHash: next.runHash,
            updatedAt: new Date(next.updatedAt),
          },
        })
        if (update.count !== 1) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Take library changed before selection persistence',
          )
        }
        await transaction.v2TakeLibrarySelection.create({
          data: {
            id: record.selection.id,
            workspaceId: next.workspaceId,
            runId: next.id,
            expectedRevision: current.revision,
            resultRevision: next.revision,
            groupId: record.selection.groupId,
            takeId: record.selection.takeId,
            protect: record.selection.protect,
            ...(record.selection.replacedProtectedTakeId
              ? {
                  replacedProtectedTakeId:
                    record.selection.replacedProtectedTakeId,
                }
              : {}),
            selectionJson: stableSerialize(record.selection),
            selectionHash: record.selection.selectionHash,
            resultRunJson: stableSerialize(next),
            resultRunHash: next.runHash,
            requestFingerprint: record.requestFingerprint,
            idempotencyKey: record.idempotencyKey,
            actorClientId: record.selection.actorClientId,
            ...batchActorAuditData(
              record.authenticationAudit,
              next.workspaceId,
              record.selection.actorClientId,
            ),
            createdAt: new Date(record.selection.createdAt),
          },
        })
        const persisted = await transaction.v2TakeLibraryRun
          .findUniqueOrThrow({ where: { id: next.id } })
        return Object.freeze({
          run: hydrateRunRow(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistSelection(record, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findSelectionReplay({
          workspaceId: record.resultingRun.workspaceId,
          actorClientId: record.selection.actorClientId,
          actorContextHash: record.authenticationAudit.contextHash,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different take selection',
            )
          }
          return Object.freeze({ run: replay.run, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Take selection conflicted with another transaction',
        )
      }
      throw error
    }
  }
}
