import {
  Prisma,
  type PrismaClient,
  type V2ScriptAlignmentRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ScriptAlignmentCreateRecord,
  ScriptAlignmentPage,
  ScriptAlignmentReplay,
  ScriptAlignmentRepository,
  ScriptAlignmentReviewRecord,
} from '../../application/ports/script-alignment-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateScriptAlignmentRun,
  type ScriptAlignmentRun,
  type ScriptBlockRole,
  type ScriptTranscriptSource,
} from '../../domain/script-alignment.ts'
import {
  hydrateStoredMediaTranscript,
} from './speech-segment-catalog-repository.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

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
  row: V2ScriptAlignmentRun,
): Readonly<ScriptAlignmentRun> {
  const document = canonicalJson<ScriptAlignmentRun['document']>(
    row.documentJson,
    'script alignment document',
  )
  const sourceRefs = canonicalJson<ScriptAlignmentRun['sourceRefs']>(
    row.sourceRefsJson,
    'script alignment source references',
  )
  const run = hydrateScriptAlignmentRun(
    canonicalJson<ScriptAlignmentRun>(
      row.resultJson,
      'script alignment result',
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.schemaVersion !== row.schemaVersion ||
    run.algorithmVersion !== row.algorithmVersion ||
    run.status !== row.status ||
    run.revision !== row.revision ||
    run.document.documentHash !== row.documentHash ||
    stableSerialize(run.document) !== stableSerialize(document) ||
    stableSerialize(run.sourceRefs) !== stableSerialize(sourceRefs) ||
    run.summary.blockCount !== row.blockCount ||
    run.summary.reviewRequiredCount !== row.reviewRequiredCount ||
    run.summary.extraTakeCount !== row.extraTakeCount ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString() ||
    run.updatedAt !== row.updatedAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored script alignment ${row.id} has inconsistent projections`,
    )
  }
  return run
}

function runData(record: Readonly<ScriptAlignmentCreateRecord>) {
  const { run } = record
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    schemaVersion: run.schemaVersion,
    algorithmVersion: run.algorithmVersion,
    status: run.status,
    revision: run.revision,
    documentHash: run.document.documentHash,
    documentJson: stableSerialize(run.document),
    sourceRefsJson: stableSerialize(run.sourceRefs),
    resultJson: stableSerialize(run),
    blockCount: run.summary.blockCount,
    reviewRequiredCount: run.summary.reviewRequiredCount,
    extraTakeCount: run.summary.extraTakeCount,
    runHash: run.runHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: run.createdByClientId,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  }
}

async function assertRunCreationContext(
  transaction: Prisma.TransactionClient,
  run: Readonly<ScriptAlignmentRun>,
) {
  const [batch, actor, transcripts] = await Promise.all([
    transaction.v2ProductionBatch.findFirst({
      where: {
        id: run.batchId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
      },
      select: {
        id: true,
        sourceGroupsJson: true,
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
    transaction.v2MediaTranscript.findMany({
      where: {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        id: { in: run.sourceRefs.map((source) => source.transcriptId) },
      },
      include: {
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
    }),
  ])
  if (!batch) {
    throw new DomainError(
      'PRODUCTION_BATCH_NOT_FOUND',
      'Script alignment production batch was not found',
    )
  }
  if (!actor) {
    throw new DomainError(
      'API_CLIENT_NOT_FOUND',
      'Script alignment actor was not found or is inactive',
    )
  }
  const sourceGroups = canonicalJson<
    readonly Readonly<{ sourceArtifactIds: readonly string[] }>[]
  >(batch.sourceGroupsJson, 'production batch source groups')
  const allowedArtifactIds = new Set(
    sourceGroups.flatMap((group) => group.sourceArtifactIds),
  )
  if (transcripts.length !== run.sourceRefs.length) {
    throw new DomainError(
      'MEDIA_TRANSCRIPT_NOT_FOUND',
      'One or more script alignment transcripts were not found',
    )
  }
  for (const reference of run.sourceRefs) {
    const row = transcripts.find((item) => item.id === reference.transcriptId)
    if (
      !row ||
      row.transcriptHash !== reference.transcriptHash ||
      row.sourceArtifactId !== reference.sourceArtifactId ||
      row.language !== reference.language
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        `Transcript ${reference.transcriptId} changed before persistence`,
      )
    }
    if (
      !allowedArtifactIds.has(row.sourceArtifactId) ||
      row.sourceArtifact.status !== 'available' ||
      !row.sourceArtifact.currentRightsSnapshot ||
      row.sourceArtifact.currentRightsSnapshot.status !== 'approved' ||
      !['approved', 'not-required'].includes(
        row.sourceArtifact.currentRightsSnapshot.consentStatus,
      )
    ) {
      throw new DomainError(
        'ASSET_RIGHTS_BLOCKED',
        `Transcript ${reference.transcriptId} is not an approved batch source`,
      )
    }
  }
}

export class PrismaScriptAlignmentRepository
implements ScriptAlignmentRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async loadCreationContext(input: {
    workspaceId: string
    batchId: string
    actorClientId: string
    sources: readonly Readonly<{
      transcriptId: string
      expectedTranscriptHash: string
      roleHint?: ScriptBlockRole
    }>[]
  }): Promise<Readonly<{
    projectId: string
    sources: readonly Readonly<ScriptTranscriptSource>[]
  }>> {
    const batch = await this.prisma.v2ProductionBatch.findFirst({
      where: {
        id: input.batchId,
        workspaceId: input.workspaceId,
      },
      select: {
        projectId: true,
        sourceGroupsJson: true,
      },
    })
    if (!batch) {
      throw new DomainError(
        'PRODUCTION_BATCH_NOT_FOUND',
        'Script alignment production batch was not found',
      )
    }
    const [actor, rows] = await Promise.all([
      this.prisma.v2ApiClient.findFirst({
        where: {
          id: input.actorClientId,
          workspaceId: input.workspaceId,
          status: 'active',
        },
        select: { id: true },
      }),
      this.prisma.v2MediaTranscript.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: batch.projectId,
          id: { in: input.sources.map((source) => source.transcriptId) },
        },
        include: {
          sourceArtifact: {
            include: { currentRightsSnapshot: true },
          },
        },
      }),
    ])
    if (!actor) {
      throw new DomainError(
        'API_CLIENT_NOT_FOUND',
        'Script alignment actor was not found or is inactive',
      )
    }
    if (rows.length !== input.sources.length) {
      throw new DomainError(
        'MEDIA_TRANSCRIPT_NOT_FOUND',
        'One or more script alignment transcripts were not found',
      )
    }
    const sourceGroups = canonicalJson<
      readonly Readonly<{ sourceArtifactIds: readonly string[] }>[]
    >(batch.sourceGroupsJson, 'production batch source groups')
    const allowedArtifactIds = new Set(
      sourceGroups.flatMap((group) => group.sourceArtifactIds),
    )
    const sources = input.sources.map((requested) => {
      const row = rows.find((candidate) =>
        candidate.id === requested.transcriptId)
      if (!row) {
        throw new DomainError(
          'MEDIA_TRANSCRIPT_NOT_FOUND',
          `Transcript ${requested.transcriptId} was not found`,
        )
      }
      if (row.transcriptHash !== requested.expectedTranscriptHash) {
        throw new DomainError(
          'VERSION_CONFLICT',
          `Transcript ${requested.transcriptId} hash is stale`,
        )
      }
      if (
        !allowedArtifactIds.has(row.sourceArtifactId) ||
        row.sourceArtifact.status !== 'available' ||
        !row.sourceArtifact.currentRightsSnapshot ||
        row.sourceArtifact.currentRightsSnapshot.status !== 'approved' ||
        !['approved', 'not-required'].includes(
          row.sourceArtifact.currentRightsSnapshot.consentStatus,
        )
      ) {
        throw new DomainError(
          'ASSET_RIGHTS_BLOCKED',
          `Transcript ${requested.transcriptId} is not an approved batch source`,
        )
      }
      const transcript = hydrateStoredMediaTranscript(row)
      return Object.freeze({
        transcriptId: row.id,
        sourceArtifactId: row.sourceArtifactId,
        transcriptHash: row.transcriptHash,
        language: row.language,
        ...(requested.roleHint ? { roleHint: requested.roleHint } : {}),
        transcript,
      })
    })
    return Object.freeze({
      projectId: batch.projectId,
      sources: Object.freeze(sources),
    })
  }

  async findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<ScriptAlignmentReplay> | null> {
    const row = await this.prisma.v2ScriptAlignmentRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row
      ? Object.freeze({
          run: hydrateRunRow(row),
          requestFingerprint: row.requestFingerprint,
        })
      : null
  }

  async create(
    record: Readonly<ScriptAlignmentCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<ScriptAlignmentRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2ScriptAlignmentRun.findFirst({
          where: {
            workspaceId: record.run.workspaceId,
            createdByClientId: record.run.createdByClientId,
            idempotencyKey: record.idempotencyKey,
          },
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different script alignment request',
            )
          }
          return Object.freeze({
            run: hydrateRunRow(replay),
            replayed: true,
          })
        }
        await assertRunCreationContext(transaction, record.run)
        const row = await transaction.v2ScriptAlignmentRun.create({
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
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different script alignment request',
            )
          }
          return Object.freeze({ run: replay.run, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Script alignment creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<ScriptAlignmentRun> | null> {
    const row = await this.prisma.v2ScriptAlignmentRun.findFirst({
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
  }): Promise<Readonly<ScriptAlignmentPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2ScriptAlignmentRun.findFirst({
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
        'Script alignment cursor is invalid',
      )
    }
    const rows = await this.prisma.v2ScriptAlignmentRun.findMany({
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
      ...(hasNextPage && runs.length
        ? { nextCursor: runs.at(-1)!.id }
        : {}),
    })
  }

  async findReviewReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<ScriptAlignmentReplay> | null> {
    const row = await this.prisma.v2ScriptAlignmentReview.findFirst({
      where: {
        workspaceId: input.workspaceId,
        actorClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      select: {
        requestFingerprint: true,
        resultRunJson: true,
        resultRunHash: true,
      },
    })
    if (!row) return null
    const run = hydrateScriptAlignmentRun(
      canonicalJson<ScriptAlignmentRun>(
        row.resultRunJson,
        'script alignment review result',
      ),
    )
    if (run.runHash !== row.resultRunHash) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored script alignment review result hash is inconsistent',
      )
    }
    return Object.freeze({
      run,
      requestFingerprint: row.requestFingerprint,
    })
  }

  async persistReview(
    record: Readonly<ScriptAlignmentReviewRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    run: Readonly<ScriptAlignmentRun>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2ScriptAlignmentReview.findFirst({
          where: {
            workspaceId: record.resultingRun.workspaceId,
            actorClientId: record.review.actorClientId,
            idempotencyKey: record.idempotencyKey,
          },
          select: {
            requestFingerprint: true,
            resultRunJson: true,
            resultRunHash: true,
          },
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different script alignment review',
            )
          }
          const run = hydrateScriptAlignmentRun(
            canonicalJson<ScriptAlignmentRun>(
              replay.resultRunJson,
              'script alignment review result',
            ),
          )
          if (run.runHash !== replay.resultRunHash) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Stored script alignment review result hash is inconsistent',
            )
          }
          return Object.freeze({ run, replayed: true })
        }
        const [currentRow, actor] = await Promise.all([
          transaction.v2ScriptAlignmentRun.findFirst({
            where: {
              id: record.previousRun.id,
              workspaceId: record.previousRun.workspaceId,
              batchId: record.previousRun.batchId,
            },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: record.review.actorClientId,
              workspaceId: record.resultingRun.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!currentRow) {
          throw new DomainError(
            'SCRIPT_ALIGNMENT_NOT_FOUND',
            'Script alignment was not found',
          )
        }
        if (!actor) {
          throw new DomainError(
            'API_CLIENT_NOT_FOUND',
            'Script alignment review actor was not found or is inactive',
          )
        }
        const current = hydrateRunRow(currentRow)
        const next = hydrateScriptAlignmentRun(record.resultingRun)
        if (
          current.runHash !== record.previousRun.runHash ||
          current.revision !== record.previousRun.revision ||
          next.revision !== current.revision + 1 ||
          next.id !== current.id ||
          next.workspaceId !== current.workspaceId ||
          next.projectId !== current.projectId ||
          next.batchId !== current.batchId ||
          next.document.documentHash !== current.document.documentHash ||
          next.createdAt !== current.createdAt ||
          record.review.revision !== next.revision ||
          next.reviews.at(-1)?.reviewHash !== record.review.reviewHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Script alignment changed before review persistence',
          )
        }
        const update = await transaction.v2ScriptAlignmentRun.updateMany({
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
            reviewRequiredCount: next.summary.reviewRequiredCount,
            extraTakeCount: next.summary.extraTakeCount,
            runHash: next.runHash,
            updatedAt: new Date(next.updatedAt),
          },
        })
        if (update.count !== 1) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Script alignment changed before review persistence',
          )
        }
        await transaction.v2ScriptAlignmentReview.create({
          data: {
            id: record.review.id,
            workspaceId: next.workspaceId,
            runId: next.id,
            expectedRevision: current.revision,
            resultRevision: next.revision,
            decisionsJson: stableSerialize(record.review.decisions),
            reviewHash: record.review.reviewHash,
            resultRunJson: stableSerialize(next),
            resultRunHash: next.runHash,
            requestFingerprint: record.requestFingerprint,
            idempotencyKey: record.idempotencyKey,
            actorClientId: record.review.actorClientId,
            createdAt: new Date(record.review.createdAt),
          },
        })
        const persisted =
          await transaction.v2ScriptAlignmentRun.findUniqueOrThrow({
            where: { id: next.id },
          })
        return Object.freeze({
          run: hydrateRunRow(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistReview(record, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findReviewReplay({
          workspaceId: record.resultingRun.workspaceId,
          actorClientId: record.review.actorClientId,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different script alignment review',
            )
          }
          return Object.freeze({ run: replay.run, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Script alignment review conflicted with another transaction',
        )
      }
      throw error
    }
  }
}
