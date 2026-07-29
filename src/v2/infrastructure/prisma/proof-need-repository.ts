import {
  Prisma,
  type PrismaClient,
  type V2ProofNeedItem,
  type V2ProofNeedRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedProofNeedRun,
  ProofNeedRepository,
} from '../../application/ports/proof-need-repository.ts'
import {
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateProofNeedRun,
  type ProofNeedItem,
  type ProofNeedRun,
} from '../../domain/proof-need.ts'
import {
  normalizeSpeechText,
} from '../../domain/speech-segment-catalog.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type RunWithItems = V2ProofNeedRun & {
  items: V2ProofNeedItem[]
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function canonicalJson<T>(
  value: string,
  field: string,
): Readonly<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    stableSerialize(parsed) !== value
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is not canonical`,
    )
  }
  return deepFreeze(parsed as T)
}

function normalizedItems(values: readonly string[]): string {
  return values.length === 0 ? '' : `\n${values.join('\n')}\n`
}

function hydrateRecord(
  row: RunWithItems,
): Readonly<PersistedProofNeedRun> {
  const run = hydrateProofNeedRun(
    canonicalJson<ProofNeedRun>(
      row.runJson,
      `ProofNeed run ${row.id}`,
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.targetRecipeId !== row.targetRecipeId ||
    run.targetRecipeHash !== row.targetRecipeHash ||
    run.baseStoryPlanId !== row.baseStoryPlanId ||
    run.baseStoryPlanHash !== row.baseStoryPlanHash ||
    run.schemaVersion !== row.schemaVersion ||
    run.policyVersion !== row.policyVersion ||
    run.objective !== row.objective ||
    stableSerialize(run.storyPlan) !== row.storyPlanJson ||
    run.storyPlan.storyPlanHash !== row.storyPlanHash ||
    run.summary.needCount !== row.needCount ||
    run.summary.requiredCount !== row.requiredCount ||
    run.summary.evidenceSearchCount !== row.evidenceSearchCount ||
    run.summary.selectedEvidenceCount !==
      row.selectedEvidenceCount ||
    run.summary.proofUnavailableCount !==
      row.proofUnavailableCount ||
    run.summary.noProofNeededCount !== row.noProofNeededCount ||
    run.summary.genericCardCount !== row.genericCardCount ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString() ||
    run.items.length !== row.items.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ProofNeed run ${row.id} failed integrity validation`,
    )
  }

  const orderedRows = row.items.toSorted(
    (left, right) => left.sequence - right.sequence,
  )
  for (let index = 0; index < run.items.length; index += 1) {
    const item = run.items[index]!
    const stored = orderedRows[index]!
    const persistedItem = canonicalJson<ProofNeedItem>(
      stored.itemJson,
      `ProofNeed item ${stored.id}`,
    )
    if (
      stableSerialize(persistedItem) !== stableSerialize(item) ||
      stored.id !== item.id ||
      stored.workspaceId !== run.workspaceId ||
      stored.projectId !== run.projectId ||
      stored.runId !== run.id ||
      stored.sequence !== item.sequence ||
      stored.storyBlockId !== item.storyBlockId ||
      stored.claimId !== item.claimId ||
      stored.claimText !== item.claimText ||
      stored.claimKind !== item.claimKind ||
      stored.type !== item.type ||
      stored.function !== item.function ||
      stored.required !== item.required ||
      stored.momentJson !== stableSerialize(item.moment) ||
      stored.momentFrame !== item.moment.timelineFrame ||
      stored.momentMs !== item.moment.timelineMs ||
      stored.searchAttempted !== item.search.attempted ||
      stored.searchedCategoriesText !==
        normalizedItems(item.search.categories) ||
      stored.candidateCount !==
        item.search.candidateEvidenceIds.length ||
      stored.resolution !== item.resolution ||
      stored.selectedEvidenceId !==
        (item.selectedEvidence?.id ?? null) ||
      stored.selectedEvidenceHash !==
        (item.selectedEvidence?.evidenceHash ?? null) ||
      stored.proofUnavailable !== item.proofUnavailable ||
      stored.genericCardGenerated !== false ||
      stored.itemHash !== item.itemHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored ProofNeed item ${stored.id} failed integrity validation`,
      )
    }
  }

  return Object.freeze({
    ...run,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

function runData(input: {
  run: Readonly<ProofNeedRun>
  requestFingerprint: string
  idempotencyKey: string
}) {
  const { run } = input
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    targetRecipeId: run.targetRecipeId,
    targetRecipeHash: run.targetRecipeHash,
    baseStoryPlanId: run.baseStoryPlanId,
    baseStoryPlanHash: run.baseStoryPlanHash,
    schemaVersion: run.schemaVersion,
    policyVersion: run.policyVersion,
    objective: run.objective,
    storyPlanJson: stableSerialize(run.storyPlan),
    storyPlanHash: run.storyPlan.storyPlanHash,
    needCount: run.summary.needCount,
    requiredCount: run.summary.requiredCount,
    evidenceSearchCount: run.summary.evidenceSearchCount,
    selectedEvidenceCount: run.summary.selectedEvidenceCount,
    proofUnavailableCount: run.summary.proofUnavailableCount,
    noProofNeededCount: run.summary.noProofNeededCount,
    genericCardCount: run.summary.genericCardCount,
    runJson: stableSerialize(run),
    runHash: run.runHash,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    createdByClientId: run.createdByClientId,
    createdAt: new Date(run.createdAt),
  }
}

function itemData(
  run: Readonly<ProofNeedRun>,
  item: Readonly<ProofNeedItem>,
) {
  return {
    id: item.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    sequence: item.sequence,
    storyBlockId: item.storyBlockId,
    claimId: item.claimId,
    claimText: item.claimText,
    claimKind: item.claimKind,
    type: item.type,
    function: item.function,
    required: item.required,
    momentJson: stableSerialize(item.moment),
    momentFrame: item.moment.timelineFrame,
    momentMs: item.moment.timelineMs,
    searchAttempted: item.search.attempted,
    searchedCategoriesText: normalizedItems(item.search.categories),
    candidateCount: item.search.candidateEvidenceIds.length,
    resolution: item.resolution,
    selectedEvidenceId: item.selectedEvidence?.id,
    selectedEvidenceHash: item.selectedEvidence?.evidenceHash,
    proofUnavailable: item.proofUnavailable,
    genericCardGenerated: false,
    itemJson: stableSerialize(item),
    itemHash: item.itemHash,
  }
}

async function readWithItems(
  client: Prisma.TransactionClient | PrismaClient,
  input: {
    workspaceId: string
    projectId: string
    runId: string
  },
): Promise<RunWithItems | null> {
  return client.v2ProofNeedRun.findFirst({
    where: {
      id: input.runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
    include: {
      items: { orderBy: { sequence: 'asc' } },
    },
  })
}

async function assertSelectedEvidenceCurrent(
  transaction: Prisma.TransactionClient,
  run: Readonly<ProofNeedRun>,
) {
  const selectedItems = run.items.filter(
    (item) => item.selectedEvidence,
  )
  const now = new Date()
  for (const item of selectedItems) {
    const selected = item.selectedEvidence!
    const evidence = await transaction.v2EvidenceSegment.findFirst({
      where: {
        id: selected.id,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        evidenceHash: selected.evidenceHash,
        category: selected.category,
        sourceArtifactId: selected.sourceArtifactId,
        sourceStartMs: selected.sourceRangeMs[0],
        sourceEndMs: selected.sourceRangeMs[1],
        contextStartMs: selected.contextRangeMs[0],
        contextEndMs: selected.contextRangeMs[1],
      },
      include: {
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
    })
    const rights = evidence?.sourceArtifact.currentRightsSnapshot
    const consentAllowed = item.type === 'demonstration'
      ? rights?.consentStatus === 'approved' ||
        rights?.consentStatus === 'not-required'
      : rights?.consentStatus === 'approved'
    if (
      !evidence ||
      evidence.claimNormalized !== normalizeSpeechText(item.claimText) ||
      evidence.integrityStatus === 'blocked' ||
      evidence.integrityReasonsJson !== '[]' ||
      evidence.rightsSnapshotId !==
        evidence.sourceArtifact.currentRightsSnapshotId ||
      !rights ||
      rights.id !== evidence.rightsSnapshotId ||
      rights.status !== 'approved' ||
      (rights.expiresAt !== null && rights.expiresAt <= now) ||
      !consentAllowed ||
      (rights.consentExpiresAt !== null &&
        rights.consentExpiresAt <= now)
    ) {
      throw new DomainError(
        'ASSET_RIGHTS_BLOCKED',
        `Selected proof evidence ${selected.id} changed or is no longer authorized`,
      )
    }
  }
}

export class PrismaProofNeedRepository
implements ProofNeedRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }) {
    const row = await this.prisma.v2ProofNeedRun.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByClientId: input.actorClientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: {
        items: { orderBy: { sequence: 'asc' } },
      },
    })
    return row ? hydrateRecord(row) : null
  }

  async create(
    input: {
      run: Readonly<ProofNeedRun>
      requestFingerprint: string
      idempotencyKey: string
    },
    attempt = 1,
  ): ReturnType<ProofNeedRepository['create']> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2ProofNeedRun.findUnique({
            where: {
              workspaceId_projectId_createdByClientId_idempotencyKey: {
                workspaceId: input.run.workspaceId,
                projectId: input.run.projectId,
                createdByClientId: input.run.createdByClientId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            include: {
              items: { orderBy: { sequence: 'asc' } },
            },
          })
        if (replay) {
          if (replay.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different ProofNeed request',
            )
          }
          return Object.freeze({
            run: hydrateRecord(replay),
            replayed: true,
          })
        }

        const [recipe, actor] = await Promise.all([
          transaction.v2VariantRecipeRun.findFirst({
            where: {
              id: input.run.targetRecipeId,
              workspaceId: input.run.workspaceId,
              projectId: input.run.projectId,
              batchId: input.run.batchId,
              runHash: input.run.targetRecipeHash,
              storyPlanHash: input.run.baseStoryPlanHash,
            },
            select: { id: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: input.run.createdByClientId,
              workspaceId: input.run.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!recipe || !actor) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'ProofNeed recipe or actor changed before commit',
          )
        }
        await assertSelectedEvidenceCurrent(transaction, input.run)

        await transaction.v2ProofNeedRun.create({
          data: runData(input),
        })
        await transaction.v2ProofNeedItem.createMany({
          data: input.run.items.map((item) =>
            itemData(input.run, item)),
        })
        const persisted = await readWithItems(transaction, {
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          runId: input.run.id,
        })
        if (!persisted) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'ProofNeed commit was not readable',
          )
        }
        return Object.freeze({
          run: hydrateRecord(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.create(input, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findReplay({
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          actorClientId: input.run.createdByClientId,
          idempotencyKey: input.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different ProofNeed request',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
      }
      if (
        isPrismaCode(error, 'P2034') ||
        isPrismaCode(error, 'P2002')
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'ProofNeed creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const row = await readWithItems(this.prisma, input)
    return row ? hydrateRecord(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    batchId?: string
    targetRecipeId?: string
    resolution?: ProofNeedItem['resolution']
    limit: number
    cursor?: string
  }) {
    const cursor = input.cursor
      ? await this.prisma.v2ProofNeedRun.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'ProofNeed cursor is invalid',
      )
    }
    const rows = await this.prisma.v2ProofNeedRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(input.targetRecipeId
          ? { targetRecipeId: input.targetRecipeId }
          : {}),
        ...(input.resolution
          ? { items: { some: { resolution: input.resolution } } }
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
      include: {
        items: { orderBy: { sequence: 'asc' } },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    })
    const hasMore = rows.length > input.limit
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows
    return Object.freeze({
      runs: Object.freeze(pageRows.map(hydrateRecord)),
      ...(hasMore
        ? { nextCursor: pageRows.at(-1)!.id }
        : {}),
    })
  }
}
