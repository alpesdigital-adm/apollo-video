import { randomUUID } from 'node:crypto'

import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  SourceCleanupCreateRecord,
  SourceCleanupPage,
  SourceCleanupRecord,
  SourceCleanupReplay,
  SourceCleanupRepository,
} from '../../application/ports/source-cleanup-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  rehydratePublicOperation,
  type PublicOperation,
  type PublicOperationResult,
} from '../../domain/public-operation.ts'
import { persistOperationStatusEvents } from './public-operation-repository.ts'
import {
  hydratePostCleanupReview,
  hydrateSourceCleanupPlan,
  SOURCE_CLEANUP_POLICY_VERSION,
  SOURCE_CLEANUP_REVIEW_SCHEMA_VERSION,
  SOURCE_CLEANUP_SCHEMA_VERSION,
  type PostCleanupReview,
  type SourceCleanupPlan,
} from '../../domain/source-cleanup.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  CONTAMINATION_REPORT_INCLUDE,
  hydrateContaminationReportRow,
} from './contamination-report-repository.ts'

const CLEANUP_INCLUDE = {
  contaminationReport: {
    include: CONTAMINATION_REPORT_INCLUDE,
  },
  operation: true,
  result: true,
} satisfies Prisma.V2SourceCleanupPlanInclude

type CleanupRow = Prisma.V2SourceCleanupPlanGetPayload<{
  include: typeof CLEANUP_INCLUDE
}>

const HASH = /^[a-f0-9]{64}$/

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

function parseOperationResult(
  value: string | null,
): PublicOperationResult | undefined {
  if (value === null) return undefined
  let result: PublicOperationResult
  try {
    result = JSON.parse(value) as PublicOperationResult
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored source cleanup operation result is invalid JSON',
    )
  }
  if (
    result.resource?.type !== 'media-artifact' ||
    typeof result.resource.id !== 'string' ||
    typeof result.resource.manifestId !== 'string'
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored source cleanup operation result is invalid',
    )
  }
  return result
}

function hydrateOperation(
  row: NonNullable<CleanupRow['operation']>,
  plan: Readonly<SourceCleanupPlan>,
): Readonly<PublicOperation> {
  if (
    plan.decision !== 'execute' ||
    row.id !== plan.operationId ||
    row.workspaceId !== plan.workspaceId ||
    row.clientId !== plan.createdByClientId ||
    row.type !== 'source-cleanup' ||
    row.projectId !== plan.projectId ||
    row.targetType !== 'media-artifact' ||
    row.targetId !== plan.outputArtifactId
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored source cleanup operation projection is inconsistent',
    )
  }
  const hasProgress = row.progressCompleted !== null
  const hasError = row.errorCode !== null ||
    row.errorMessage !== null ||
    row.errorRetryable !== null
  return rehydratePublicOperation({
    schemaVersion: 'public-operation/v1',
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: plan.projectId,
    clientId: row.clientId,
    type: 'source-cleanup',
    status: row.status as PublicOperation['status'],
    phase: row.phase as PublicOperation['phase'],
    ...(hasProgress
      ? {
          progress: {
            completed: row.progressCompleted as number,
            ...(row.progressTotal !== null
              ? { total: row.progressTotal }
              : {}),
            ...(row.progressUnit !== null
              ? { unit: row.progressUnit }
              : {}),
          },
        }
      : {}),
    cancelable: row.cancelable,
    retryable: row.retryable,
    target: {
      type: 'media-artifact',
      id: plan.outputArtifactId!,
      manifestId: plan.outputManifestId!,
    },
    ...(row.resultJson !== null
      ? { result: parseOperationResult(row.resultJson) }
      : {}),
    ...(hasError
      ? {
          error: {
            code: row.errorCode as string,
            message: row.errorMessage as string,
            retryable: row.errorRetryable as boolean,
          },
        }
      : {}),
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.startedAt
      ? { startedAt: row.startedAt.toISOString() }
      : {}),
    ...(row.completedAt
      ? { completedAt: row.completedAt.toISOString() }
      : {}),
    ...(row.nextAttemptAt
      ? { nextAttemptAt: row.nextAttemptAt.toISOString() }
      : {}),
    ...(row.deadLetteredAt
      ? { deadLetteredAt: row.deadLetteredAt.toISOString() }
      : {}),
  })
}

function hydrateRecord(row: CleanupRow): Readonly<SourceCleanupRecord> {
  const report = hydrateContaminationReportRow(
    row.contaminationReport,
  )
  const storedPlan = canonicalJson<SourceCleanupPlan>(
    row.planJson,
    `source cleanup plan ${row.id}`,
  )
  const plan = hydrateSourceCleanupPlan(storedPlan, report)
  const policy = canonicalJson(
    row.policyJson,
    `source cleanup plan ${row.id} policy`,
  )
  const candidates = canonicalJson(
    row.candidatesJson,
    `source cleanup plan ${row.id} candidates`,
  )
  const selectedAction = canonicalJson(
    row.selectedActionJson,
    `source cleanup plan ${row.id} selected action`,
  )
  const rightsReasonCodes = canonicalJson(
    row.rightsReasonCodesJson,
    `source cleanup plan ${row.id} rights reasons`,
  )
  if (
    row.id !== plan.id ||
    row.workspaceId !== plan.workspaceId ||
    row.projectId !== plan.projectId ||
    row.contaminationReportId !== plan.contaminationReportId ||
    row.contaminationReportHash !== plan.contaminationReportHash ||
    row.findingId !== plan.findingId ||
    row.findingHash !== plan.findingHash ||
    row.sourceArtifactId !== plan.sourceArtifactId ||
    row.sourceArtifactSha256 !== plan.sourceArtifactSha256 ||
    row.sourceManifestId !== plan.sourceManifestId ||
    row.sourceDurationMs !== plan.sourceDurationMs ||
    row.schemaVersion !== SOURCE_CLEANUP_SCHEMA_VERSION ||
    row.policyVersion !== SOURCE_CLEANUP_POLICY_VERSION ||
    stableSerialize(policy) !== stableSerialize(plan.policy) ||
    row.policyHash !== calculateCanonicalHash(plan.policy) ||
    stableSerialize(candidates) !== stableSerialize(plan.candidates) ||
    row.candidatesHash !== calculateCanonicalHash(plan.candidates) ||
    row.selectedStrategy !== plan.selectedStrategy ||
    stableSerialize(selectedAction) !==
      stableSerialize(plan.selectedAction) ||
    row.selectedActionHash !==
      calculateCanonicalHash(plan.selectedAction) ||
    row.decision !== plan.decision ||
    row.predictedResidualQuality !==
      plan.predictedResidualQuality ||
    row.predictedIntegrity !== plan.predictedIntegrity ||
    row.predictedCost !== plan.predictedCost ||
    row.sourceImmutable !== plan.sourceImmutable ||
    row.rightsSnapshotId !== (plan.rightsSnapshotId ?? null) ||
    row.rightsSnapshotHash !== (plan.rightsSnapshotHash ?? null) ||
    row.rightsDecision !== plan.rightsDecision ||
    stableSerialize(rightsReasonCodes) !==
      stableSerialize(plan.rightsReasonCodes) ||
    row.postCleanupReviewRequired !==
      plan.postCleanupReviewRequired ||
    row.operationId !== (plan.operationId ?? null) ||
    row.outputArtifactId !== (plan.outputArtifactId ?? null) ||
    row.outputManifestId !== (plan.outputManifestId ?? null) ||
    row.planHash !== plan.planHash ||
    row.createdByClientId !== plan.createdByClientId ||
    row.createdAt.toISOString() !== plan.createdAt
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored source cleanup plan ${row.id} has inconsistent projections`,
    )
  }
  if (
    (plan.decision === 'execute' && !row.operation) ||
    (plan.decision === 'reject' && Boolean(row.operation))
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored source cleanup operation presence is inconsistent',
    )
  }
  const operation = row.operation
    ? hydrateOperation(row.operation, plan)
    : undefined
  let review: Readonly<PostCleanupReview> | undefined
  if (row.result) {
    const storedReview = canonicalJson<PostCleanupReview>(
      row.result.reviewJson,
      `source cleanup result ${row.id}`,
    )
    review = hydratePostCleanupReview(storedReview, plan)
    if (
      row.result.workspaceId !== plan.workspaceId ||
      row.result.projectId !== plan.projectId ||
      row.result.outputArtifactId !== review.outputArtifactId ||
      row.result.outputArtifactSha256 !==
        review.outputArtifactSha256 ||
      row.result.outputManifestId !== review.outputManifestId ||
      row.result.strategy !== review.strategy ||
      row.result.visualPassed !== review.visual.passed ||
      row.result.rightsPassed !== review.rights.passed ||
      row.result.passed !== review.passed ||
      row.result.residualQuality !==
        review.visual.residualQuality ||
      row.result.sourceRightsSnapshotId !==
        review.rights.sourceRightsSnapshotId ||
      row.result.sourceRightsSnapshotHash !==
        review.rights.sourceRightsSnapshotHash ||
      row.result.outputRightsSnapshotId !==
        review.rights.outputRightsSnapshotId ||
      row.result.outputRightsSnapshotHash !==
        review.rights.outputRightsSnapshotHash ||
      row.result.reviewHash !== review.reviewHash ||
      row.result.completedAt.toISOString() !== review.reviewedAt
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored post-cleanup review projection is inconsistent',
      )
    }
  }
  return Object.freeze({
    plan,
    ...(operation ? { operation } : {}),
    ...(review ? { review } : {}),
  })
}

function operationData(
  operation: Readonly<PublicOperation>,
  idempotencyKey: string,
  requestFingerprint: string,
  traceId?: string,
) {
  return {
    id: operation.id,
    workspaceId: operation.workspaceId,
    projectId: operation.projectId,
    clientId: operation.clientId,
    type: operation.type,
    status: operation.status,
    phase: operation.phase,
    targetType: operation.target.type,
    targetId: operation.target.id,
    progressCompleted: operation.progress?.completed,
    progressTotal: operation.progress?.total,
    progressUnit: operation.progress?.unit,
    cancelable: operation.cancelable,
    retryable: operation.retryable,
    attempt: operation.attempt,
    maxAttempts: operation.maxAttempts,
    idempotencyKey,
    requestFingerprint,
    traceId,
    createdAt: new Date(operation.createdAt),
    updatedAt: new Date(operation.updatedAt),
  }
}

function planData(record: Readonly<SourceCleanupCreateRecord>) {
  const { plan } = record
  return {
    id: plan.id,
    workspaceId: plan.workspaceId,
    projectId: plan.projectId,
    contaminationReportId: plan.contaminationReportId,
    contaminationReportHash: plan.contaminationReportHash,
    findingId: plan.findingId,
    findingHash: plan.findingHash,
    sourceArtifactId: plan.sourceArtifactId,
    sourceArtifactSha256: plan.sourceArtifactSha256,
    sourceManifestId: plan.sourceManifestId,
    sourceDurationMs: plan.sourceDurationMs,
    schemaVersion: plan.schemaVersion,
    policyVersion: plan.policyVersion,
    policyJson: stableSerialize(plan.policy),
    policyHash: calculateCanonicalHash(plan.policy),
    candidatesJson: stableSerialize(plan.candidates),
    candidatesHash: calculateCanonicalHash(plan.candidates),
    selectedStrategy: plan.selectedStrategy,
    selectedActionJson: stableSerialize(plan.selectedAction),
    selectedActionHash: calculateCanonicalHash(plan.selectedAction),
    decision: plan.decision,
    predictedResidualQuality: plan.predictedResidualQuality,
    predictedIntegrity: plan.predictedIntegrity,
    predictedCost: plan.predictedCost,
    sourceImmutable: plan.sourceImmutable,
    rightsSnapshotId: plan.rightsSnapshotId,
    rightsSnapshotHash: plan.rightsSnapshotHash,
    rightsDecision: plan.rightsDecision,
    rightsReasonCodesJson: stableSerialize(plan.rightsReasonCodes),
    postCleanupReviewRequired: plan.postCleanupReviewRequired,
    operationId: plan.operationId,
    outputArtifactId: plan.outputArtifactId,
    outputManifestId: plan.outputManifestId,
    planJson: stableSerialize(plan),
    planHash: plan.planHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: plan.createdByClientId,
    createdAt: new Date(plan.createdAt),
  }
}

export class PrismaSourceCleanupRepository
implements SourceCleanupRepository {
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient = getV2PostgresClient()) {
    this.prisma = prisma
  }

  async findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<SourceCleanupReplay> | null> {
    const row = await this.prisma.v2SourceCleanupPlan.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByClientId: input.actorClientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: CLEANUP_INCLUDE,
    })
    return row
      ? Object.freeze({
          record: hydrateRecord(row),
          requestFingerprint: row.requestFingerprint,
        })
      : null
  }

  async create(
    record: Readonly<SourceCleanupCreateRecord>,
  ): Promise<Readonly<SourceCleanupRecord & { replayed: boolean }>> {
    if (
      !HASH.test(record.requestFingerprint) ||
      record.idempotencyKey.length < 8 ||
      record.idempotencyKey.length > 128 ||
      (record.plan.decision === 'execute' &&
        (!record.operation || !record.operationContext)) ||
      (record.plan.decision === 'reject' &&
        (record.operation || record.operationContext))
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Source cleanup persistence input is invalid',
      )
    }
    if (record.operation && record.operationContext) {
      const operation = record.operation
      const context = record.operationContext
      if (
        operation.type !== 'source-cleanup' ||
        operation.status !== 'queued' ||
        operation.target.type !== 'media-artifact' ||
        operation.id !== record.plan.operationId ||
        operation.workspaceId !== record.plan.workspaceId ||
        operation.projectId !== record.plan.projectId ||
        operation.clientId !== record.plan.createdByClientId ||
        operation.target.id !== record.plan.outputArtifactId ||
        operation.target.manifestId !==
          record.plan.outputManifestId ||
        context.cleanupPlanId !== record.plan.id ||
        context.cleanupPlanHash !== record.plan.planHash ||
        context.projectId !== record.plan.projectId ||
        context.sourceArtifactId !==
          record.plan.sourceArtifactId ||
        context.sourceArtifactSha256 !==
          record.plan.sourceArtifactSha256 ||
        context.sourceManifestId !==
          record.plan.sourceManifestId ||
        context.outputArtifactId !==
          record.plan.outputArtifactId ||
        context.outputManifestId !==
          record.plan.outputManifestId ||
        context.strategy !== record.plan.selectedStrategy
      ) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'Source cleanup operation does not match its immutable plan',
        )
      }
    }
    try {
      const row = await this.prisma.$transaction(async (transaction) => {
        const existing =
          await transaction.v2SourceCleanupPlan.findUnique({
            where: {
              workspaceId_projectId_createdByClientId_idempotencyKey: {
                workspaceId: record.plan.workspaceId,
                projectId: record.plan.projectId,
                createdByClientId: record.plan.createdByClientId,
                idempotencyKey: record.idempotencyKey,
              },
            },
            include: CLEANUP_INCLUDE,
          })
        if (existing) {
          if (
            existing.requestFingerprint !==
            record.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different source cleanup request',
            )
          }
          return { row: existing, replayed: true }
        }
        if (record.operation) {
          const conflictingOperation =
            await transaction.v2PublicOperation.findUnique({
              where: {
                workspaceId_clientId_idempotencyKey: {
                  workspaceId: record.plan.workspaceId,
                  clientId: record.plan.createdByClientId,
                  idempotencyKey: record.idempotencyKey,
                },
              },
              select: {
                id: true,
                requestFingerprint: true,
                type: true,
              },
            })
          if (conflictingOperation) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used by another public operation',
              {
                operationId: conflictingOperation.id,
                operationType: conflictingOperation.type,
              },
            )
          }
          await transaction.v2PublicOperation.create({
            data: operationData(
              record.operation,
              record.idempotencyKey,
              record.requestFingerprint,
              record.traceId,
            ),
          })
          await persistOperationStatusEvents(
            transaction,
            undefined,
            record.operation,
            randomUUID,
          )
        }
        const created = await transaction.v2SourceCleanupPlan.create({
          data: planData(record),
          include: CLEANUP_INCLUDE,
        })
        return { row: created, replayed: false }
      }, {
        isolationLevel:
          Prisma.TransactionIsolationLevel.Serializable,
      })
      return Object.freeze({
        ...hydrateRecord(row.row),
        replayed: row.replayed,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2002') || isPrismaCode(error, 'P2034')) {
        const replay = await this.findCreateReplay({
          workspaceId: record.plan.workspaceId,
          projectId: record.plan.projectId,
          actorClientId: record.plan.createdByClientId,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different source cleanup request',
            )
          }
          return Object.freeze({
            ...replay.record,
            replayed: true,
          })
        }
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    cleanupPlanId: string
  }): Promise<Readonly<SourceCleanupRecord> | null> {
    const row = await this.prisma.v2SourceCleanupPlan.findFirst({
      where: {
        id: input.cleanupPlanId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: CLEANUP_INCLUDE,
    })
    return row ? hydrateRecord(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    contaminationReportId?: string
    findingId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<SourceCleanupPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2SourceCleanupPlan.findFirst({
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
        'Source cleanup cursor is invalid',
      )
    }
    const rows = await this.prisma.v2SourceCleanupPlan.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.contaminationReportId
          ? {
              contaminationReportId:
                input.contaminationReportId,
            }
          : {}),
        ...(input.findingId ? { findingId: input.findingId } : {}),
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
      include: CLEANUP_INCLUDE,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    })
    return Object.freeze({
      cleanups: Object.freeze(
        rows.slice(0, input.limit).map(hydrateRecord),
      ),
      ...(rows.length > input.limit
        ? { nextCursor: rows[input.limit - 1]!.id }
        : {}),
    })
  }

  async persistReview(input: {
    review: Readonly<PostCleanupReview>
  }): Promise<Readonly<SourceCleanupRecord>> {
    if (
      input.review.schemaVersion !==
        SOURCE_CLEANUP_REVIEW_SCHEMA_VERSION
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Post-cleanup review version is invalid',
      )
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const plan = await transaction.v2SourceCleanupPlan.findFirst({
          where: {
            id: input.review.cleanupPlanId,
            planHash: input.review.cleanupPlanHash,
          },
          include: CLEANUP_INCLUDE,
        })
        if (!plan) {
          throw new DomainError(
            'SOURCE_CLEANUP_NOT_FOUND',
            'Source cleanup plan was not found',
          )
        }
        const current = hydrateRecord(plan)
        const review = hydratePostCleanupReview(
          input.review,
          current.plan,
        )
        if (current.review) {
          if (current.review.reviewHash !== review.reviewHash) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Source cleanup result already exists with different evidence',
            )
          }
          return current
        }
        await transaction.v2SourceCleanupResult.create({
          data: {
            cleanupPlanId: review.cleanupPlanId,
            workspaceId: current.plan.workspaceId,
            projectId: current.plan.projectId,
            outputArtifactId: review.outputArtifactId,
            outputArtifactSha256:
              review.outputArtifactSha256,
            outputManifestId: review.outputManifestId,
            strategy: review.strategy,
            visualPassed: review.visual.passed,
            rightsPassed: review.rights.passed,
            passed: review.passed,
            residualQuality: review.visual.residualQuality,
            sourceRightsSnapshotId:
              review.rights.sourceRightsSnapshotId,
            sourceRightsSnapshotHash:
              review.rights.sourceRightsSnapshotHash,
            outputRightsSnapshotId:
              review.rights.outputRightsSnapshotId,
            outputRightsSnapshotHash:
              review.rights.outputRightsSnapshotHash,
            reviewJson: stableSerialize(review),
            reviewHash: review.reviewHash,
            completedAt: new Date(review.reviewedAt),
          },
        })
        const persisted =
          await transaction.v2SourceCleanupPlan.findUnique({
            where: { id: current.plan.id },
            include: CLEANUP_INCLUDE,
          })
        if (!persisted) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Source cleanup result was not persisted',
          )
        }
        return hydrateRecord(persisted)
      }, {
        isolationLevel:
          Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2002')) {
        const current = await this.prisma.v2SourceCleanupPlan.findFirst({
          where: { id: input.review.cleanupPlanId },
          include: CLEANUP_INCLUDE,
        })
        if (current) {
          const hydrated = hydrateRecord(current)
          if (
            hydrated.review?.reviewHash ===
            input.review.reviewHash
          ) {
            return hydrated
          }
        }
      }
      throw error
    }
  }
}
