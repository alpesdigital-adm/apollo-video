import { randomUUID } from 'node:crypto'

import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedProxyReview,
  ProxyReviewDecision,
  ProxyReviewRepository,
} from '../../application/ports/proxy-review-repository.ts'
import {
  calculateProxyReviewHash,
  type ProxyQualityIssue,
  type ProxyReview,
} from '../../application/render-workflow.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { projectStatusTransitionSources } from '../../domain/project.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

type StoredProxyReview = Prisma.V2ProxyReviewGetPayload<Record<string, never>>
type StoredProxyReviewDecision = Prisma.V2ProxyReviewDecisionGetPayload<Record<string, never>>

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseIssueArray(value: string, field: string): readonly Readonly<ProxyQualityIssue>[] {
  const parsed = parseJson(value, field)
  if (!Array.isArray(parsed)) throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  const issues = parsed.map((candidate) => {
    if (
      typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) ||
      typeof candidate.code !== 'string' ||
      !['hard', 'warning'].includes(String(candidate.severity)) ||
      !['technical', 'policy', 'integrity', 'editorial'].includes(String(candidate.category)) ||
      typeof candidate.message !== 'string' ||
      typeof candidate.correctable !== 'boolean'
    ) throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
    const range = candidate.rangeMs
    const evidenceRange = candidate.evidenceRange
    if (
      range !== undefined &&
      (!Array.isArray(range) || range.length !== 2 || range.some((item) => !Number.isSafeInteger(item) || item < 0))
    ) throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} range is invalid`)
    if (evidenceRange !== undefined && (
      typeof evidenceRange !== 'object' || evidenceRange === null || Array.isArray(evidenceRange) ||
      !Number.isSafeInteger((evidenceRange as Record<string, unknown>).startFrame) ||
      !Number.isSafeInteger((evidenceRange as Record<string, unknown>).endFrame) ||
      Number((evidenceRange as Record<string, unknown>).startFrame) < 0 ||
      Number((evidenceRange as Record<string, unknown>).endFrame) <= Number((evidenceRange as Record<string, unknown>).startFrame)
    )) throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} evidence range is invalid`)
    if ((candidate.elementIds !== undefined && (!Array.isArray(candidate.elementIds) || candidate.elementIds.some((item: unknown) => typeof item !== 'string'))) ||
      (candidate.evidenceIds !== undefined && (!Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.some((item: unknown) => typeof item !== 'string')))) {
      throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} evidence identities are invalid`)
    }
    return Object.freeze({
      code: candidate.code,
      severity: candidate.severity as 'hard' | 'warning',
      category: candidate.category as ProxyQualityIssue['category'],
      message: candidate.message,
      ...(range ? { rangeMs: Object.freeze([range[0], range[1]] as [number, number]) } : {}),
      ...(typeof candidate.targetId === 'string' ? { targetId: candidate.targetId } : {}),
      ...(typeof candidate.outputSpecId === 'string' ? { outputSpecId: candidate.outputSpecId } : {}),
      ...(evidenceRange
        ? { evidenceRange: Object.freeze({ startFrame: Number((evidenceRange as Record<string, unknown>).startFrame), endFrame: Number((evidenceRange as Record<string, unknown>).endFrame) }) }
        : {}),
      ...(Array.isArray(candidate.elementIds) ? { elementIds: Object.freeze(candidate.elementIds.map(String)) } : {}),
      ...(Array.isArray(candidate.evidenceIds) ? { evidenceIds: Object.freeze(candidate.evidenceIds.map(String)) } : {}),
      correctable: candidate.correctable,
    })
  })
  return Object.freeze(issues)
}

const geometryHash = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))

function parseFormatQuality(value: string | null): Readonly<ProxyReview>['formatQuality'] {
  if (value === null) return undefined
  const candidate = parseJson(value, 'proxy format quality verdict') as Record<string, unknown>
  if (
    typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) ||
    typeof candidate.outputPresetHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.outputPresetHash) ||
    typeof candidate.reportHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.reportHash) ||
    !['passed', 'warning', 'blocked'].includes(String(candidate.status)) ||
    typeof candidate.exportAllowed !== 'boolean' || typeof candidate.explanation !== 'string' ||
    candidate.exportAllowed !== (candidate.status !== 'blocked') ||
    // The verdict is only readable together with the geometry it judged.
    !geometryHash(candidate.placementPlanHash) || !geometryHash(candidate.reframePlanHash)
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy format quality verdict is invalid')
  return Object.freeze({
    outputPresetHash: candidate.outputPresetHash,
    placementPlanHash: (candidate.placementPlanHash ?? null) as string | null,
    reframePlanHash: (candidate.reframePlanHash ?? null) as string | null,
    status: candidate.status as 'passed' | 'warning' | 'blocked',
    exportAllowed: candidate.exportAllowed,
    explanation: candidate.explanation,
    reportHash: candidate.reportHash,
  })
}

export function hydrateProxyReview(row: StoredProxyReview): Readonly<PersistedProxyReview> {
  const parsedSpec = parseJson(row.specJson, 'proxy review spec')
  const spec = parsedSpec as Record<string, unknown>
  if (
    typeof spec !== 'object' || spec === null || Array.isArray(spec) ||
    typeof spec.width !== 'number' || typeof spec.height !== 'number' ||
    spec.codec !== 'h264' || spec.container !== 'mp4' ||
    spec.quality !== 'review' || spec.reusableRanges !== true ||
    !['blocked', 'warning-ack-required', 'ready-for-final'].includes(row.status) ||
    row.timeToFirstProxyMs < BigInt(0) || row.timeToFirstProxyMs > BigInt(Number.MAX_SAFE_INTEGER)
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy review is invalid')
  const review: Omit<ProxyReview, 'reviewHash'> = Object.freeze({
    schemaVersion: 'proxy-review/v1',
    projectVersionId: row.projectVersionId,
    proxyArtifactId: row.proxyArtifactId,
    proxyManifestId: row.proxyManifestId,
    inputHash: row.inputHash,
    outputSpecId: row.outputSpecId,
    rangeCacheKey: row.rangeCacheKey,
    spec: Object.freeze({
      width: spec.width,
      height: spec.height,
      codec: 'h264',
      container: 'mp4',
      quality: 'review',
      reusableRanges: true,
    }),
    status: row.status as ProxyReview['status'],
    technicalIssues: parseIssueArray(row.technicalIssuesJson, 'proxy technical issues'),
    criticIssues: parseIssueArray(row.criticIssuesJson, 'proxy critic issues'),
    ...(row.formatQualityJson === null ? {} : { formatQuality: parseFormatQuality(row.formatQualityJson) }),
    warningsAcknowledged: row.warningsAcknowledged,
    finalAllowed: row.finalAllowed,
    uploadReceivedAt: row.uploadReceivedAt.toISOString(),
    renderCompletedAt: row.renderCompletedAt.toISOString(),
    timeToFirstProxyMs: Number(row.timeToFirstProxyMs),
  })
  if (calculateProxyReviewHash(review) !== row.reviewHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy review hash is inconsistent')
  }
  const acknowledgedBy = row.acknowledgedByType && row.acknowledgedById && row.acknowledgedAt
    ? Object.freeze({
        type: row.acknowledgedByType as 'api-client',
        id: row.acknowledgedById,
        at: row.acknowledgedAt.toISOString(),
      })
    : undefined
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    operationId: row.operationId,
    ...review,
    reviewHash: row.reviewHash,
    revision: row.revision,
    ...(acknowledgedBy ? { acknowledgedBy } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function hydrateDecision(row: StoredProxyReviewDecision): Readonly<ProxyReviewDecision> {
  hydrateExternalActorAudit(row, row.actorId)
  if (row.action !== 'acknowledge-warnings' || row.actorType !== 'api-client') {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy review decision is invalid')
  }
  return Object.freeze({
    id: row.id,
    proxyReviewId: row.proxyReviewId,
    action: 'acknowledge-warnings',
    actor: Object.freeze({ type: 'api-client', id: row.actorId }),
    baseReviewHash: row.baseReviewHash,
    resultReviewHash: row.resultReviewHash,
    createdAt: row.createdAt.toISOString(),
  })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaProxyReviewRepository implements ProxyReviewRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async persistGenerated(input: Parameters<ProxyReviewRepository['persistGenerated']>[0]) {
    return this.client.$transaction(async (transaction) => {
      const existing = await transaction.v2ProxyReview.findUnique({
        where: { operationId: input.operationId },
      })
      if (existing) {
        if (
          existing.workspaceId !== input.workspaceId ||
          existing.projectId !== input.projectId ||
          existing.reviewHash !== input.review.reviewHash
        ) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review identity did not converge')
        return hydrateProxyReview(existing)
      }
      const createdAt = new Date(input.createdAt)
      if (Number.isNaN(createdAt.getTime())) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review creation time is invalid')
      const row = await transaction.v2ProxyReview.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: input.review.projectVersionId,
          operationId: input.operationId,
          proxyArtifactId: input.review.proxyArtifactId,
          proxyManifestId: input.review.proxyManifestId,
          inputHash: input.review.inputHash,
          outputSpecId: input.review.outputSpecId,
          rangeCacheKey: input.review.rangeCacheKey,
          specJson: stableSerialize(input.review.spec),
          status: input.review.status,
          technicalIssuesJson: stableSerialize(input.review.technicalIssues),
          criticIssuesJson: stableSerialize(input.review.criticIssues),
          formatQualityJson: input.review.formatQuality ? stableSerialize(input.review.formatQuality) : null,
          warningsAcknowledged: input.review.warningsAcknowledged,
          finalAllowed: input.review.finalAllowed,
          reviewHash: input.review.reviewHash,
          revision: 1,
          uploadReceivedAt: new Date(input.review.uploadReceivedAt),
          renderCompletedAt: new Date(input.review.renderCompletedAt),
          timeToFirstProxyMs: BigInt(input.review.timeToFirstProxyMs),
          createdAt,
          updatedAt: createdAt,
        },
      })
      const project = await transaction.v2Project.updateMany({
        where: {
          id: input.projectId,
          workspaceId: input.workspaceId,
          currentVersionId: input.review.projectVersionId,
          status: {
            in: projectStatusTransitionSources(
              input.review.status === 'blocked' ? 'revising' : 'reviewing-proxy',
              { includeSame: true },
            ),
          },
        },
        data: { status: input.review.status === 'blocked' ? 'revising' : 'reviewing-proxy' },
      })
      if (project.count !== 1) {
        throw new DomainError('VERSION_CONFLICT', 'Proxy review no longer belongs to the current project version')
      }
      await transaction.v2PublicEventOutbox.create({
        data: {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          type: 'quality.report.created',
          version: '1.0.0',
          occurredAt: createdAt,
          sequence: 1,
          resourceType: 'quality-report',
          resourceId: input.id,
          dataJson: stableSerialize({
            schemaVersion: 1,
            projectId: input.projectId,
            projectVersionId: input.review.projectVersionId,
            proxyArtifactId: input.review.proxyArtifactId,
            status: input.review.status,
            finalAllowed: input.review.finalAllowed,
            reviewHash: input.review.reviewHash,
            timeToFirstProxyMs: input.review.timeToFirstProxyMs,
          }),
        },
      })
      return hydrateProxyReview(row)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async findCurrent(input: Parameters<ProxyReviewRepository['findCurrent']>[0]) {
    const row = await this.client.v2ProxyReview.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.projectVersionId
          ? { projectVersionId: input.projectVersionId }
          : { projectVersion: { currentForProjects: { some: { id: input.projectId, workspaceId: input.workspaceId } } } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrateProxyReview(row) : null
  }

  private async findDecisionReplay(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    requestFingerprint: string
    authenticationAudit: Parameters<ProxyReviewRepository['acknowledgeWarnings']>[0]['authenticationAudit']
  }) {
    const decision = await this.client.v2ProxyReviewDecision.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    if (!decision) return null
    const audit = hydrateExternalActorAudit(decision, decision.actorId)
    if (audit.contextHash !== input.authenticationAudit.contextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
    }
    if (decision.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was used with a different proxy review decision',
      )
    }
    const review = await this.client.v2ProxyReview.findUnique({
      where: { id: decision.proxyReviewId },
    })
    if (!review) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review decision lost its review')
    return Object.freeze({ review: hydrateProxyReview(review), decision: hydrateDecision(decision), replayed: true })
  }

  async acknowledgeWarnings(
    input: Parameters<ProxyReviewRepository['acknowledgeWarnings']>[0],
    serializationAttempt = 1,
  ): ReturnType<ProxyReviewRepository['acknowledgeWarnings']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_projectId_idempotencyKey: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        }
        const existing = await transaction.v2ProxyReviewDecision.findUnique({ where: key })
        if (existing) {
          const audit = hydrateExternalActorAudit(existing, existing.actorId)
          if (audit.contextHash !== input.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
          }
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different proxy review decision',
            )
          }
          const review = await transaction.v2ProxyReview.findUniqueOrThrow({
            where: { id: existing.proxyReviewId },
          })
          return Object.freeze({
            review: hydrateProxyReview(review),
            decision: hydrateDecision(existing),
            replayed: true,
          })
        }
        const [reviewRow, project] = await Promise.all([
          transaction.v2ProxyReview.findFirst({
            where: {
              id: input.proxyReviewId,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              projectVersionId: input.projectVersionId,
            },
          }),
          transaction.v2Project.findFirst({
            where: {
              id: input.projectId,
              workspaceId: input.workspaceId,
              currentVersionId: input.projectVersionId,
            },
            select: { id: true },
          }),
        ])
        if (!reviewRow || !project) {
          throw new DomainError('VERSION_CONFLICT', 'Proxy review or current project version changed')
        }
        if (
          reviewRow.reviewHash !== input.baseReviewHash ||
          reviewRow.revision !== input.expectedRevision
        ) {
          throw new DomainError('VERSION_CONFLICT', 'Proxy review changed before warning acknowledgement', {
            currentReviewHash: reviewRow.reviewHash,
            currentRevision: reviewRow.revision,
          })
        }
        const hydrated = hydrateProxyReview(reviewRow)
        const warnings = [...hydrated.technicalIssues, ...hydrated.criticIssues]
          .filter((issue) => issue.severity === 'warning')
        const hard = [...hydrated.technicalIssues, ...hydrated.criticIssues]
          .filter((issue) => issue.severity === 'hard')
        if (hard.length > 0 || warnings.length === 0 || hydrated.status !== 'warning-ack-required') {
          throw new DomainError(
            'PRECONDITION_REQUIRED',
            hard.length > 0
              ? 'Hard proxy issues can never be acknowledged'
              : 'Proxy review has no pending warnings to acknowledge',
          )
        }
        const acknowledgedAt = new Date(input.createdAt)
        if (Number.isNaN(acknowledgedAt.getTime())) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review acknowledgement time is invalid')
        }
        const reviewWithoutHash: Omit<ProxyReview, 'reviewHash'> = Object.freeze({
          schemaVersion: hydrated.schemaVersion,
          projectVersionId: hydrated.projectVersionId,
          proxyArtifactId: hydrated.proxyArtifactId,
          proxyManifestId: hydrated.proxyManifestId,
          inputHash: hydrated.inputHash,
          outputSpecId: hydrated.outputSpecId,
          rangeCacheKey: hydrated.rangeCacheKey,
          spec: hydrated.spec,
          status: 'ready-for-final',
          technicalIssues: hydrated.technicalIssues,
          criticIssues: hydrated.criticIssues,
          ...(hydrated.formatQuality ? { formatQuality: hydrated.formatQuality } : {}),
          warningsAcknowledged: true,
          finalAllowed: true,
          uploadReceivedAt: hydrated.uploadReceivedAt,
          renderCompletedAt: hydrated.renderCompletedAt,
          timeToFirstProxyMs: hydrated.timeToFirstProxyMs,
        })
        const resultReviewHash = calculateProxyReviewHash(reviewWithoutHash)
        const updated = await transaction.v2ProxyReview.updateMany({
          where: {
            id: input.proxyReviewId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            projectVersionId: input.projectVersionId,
            reviewHash: input.baseReviewHash,
            revision: input.expectedRevision,
            status: 'warning-ack-required',
            finalAllowed: false,
          },
          data: {
            status: 'ready-for-final',
            warningsAcknowledged: true,
            finalAllowed: true,
            reviewHash: resultReviewHash,
            revision: { increment: 1 },
            acknowledgedByType: input.actor.type,
            acknowledgedById: input.actor.id,
            acknowledgedAt,
            updatedAt: acknowledgedAt,
          },
        })
        if (updated.count !== 1) {
          throw new DomainError('VERSION_CONFLICT', 'Proxy review changed during warning acknowledgement')
        }
        const decision = await transaction.v2ProxyReviewDecision.create({
          data: {
            id: input.decisionId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            proxyReviewId: input.proxyReviewId,
            action: 'acknowledge-warnings',
            actorType: input.actor.type,
            actorId: input.actor.id,
            ...externalActorAuditData(input.authenticationAudit, input.workspaceId, input.actor.id),
            baseReviewHash: input.baseReviewHash,
            resultReviewHash,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            createdAt: acknowledgedAt,
          },
        })
        await transaction.v2PublicEventOutbox.create({
          data: {
            id: randomUUID(),
            workspaceId: input.workspaceId,
            type: 'approval.changed',
            version: '1.0.0',
            occurredAt: acknowledgedAt,
            sequence: input.expectedRevision + 1,
            actorClientId: input.actor.id,
            resourceType: 'approval',
            resourceId: input.proxyReviewId,
            dataJson: stableSerialize({
              schemaVersion: 1,
              projectId: input.projectId,
              projectVersionId: input.projectVersionId,
              proxyReviewId: input.proxyReviewId,
              action: 'acknowledge-warnings',
              finalAllowed: true,
              reviewHash: resultReviewHash,
            }),
          },
        })
        const review = await transaction.v2ProxyReview.findUniqueOrThrow({
          where: { id: input.proxyReviewId },
        })
        return Object.freeze({
          review: hydrateProxyReview(review),
          decision: hydrateDecision(decision),
          replayed: false,
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.acknowledgeWarnings(input, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findDecisionReplay(input)
        if (replay) return replay
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review acknowledgement collided with persisted state')
      }
      throw error
    }
  }
}
