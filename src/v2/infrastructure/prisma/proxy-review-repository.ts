import { randomUUID } from 'node:crypto'

import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedProxyReview,
  ProxyReviewCarriedFrom,
  ProxyReviewDecision,
  ProxyReviewRepository,
} from '../../application/ports/proxy-review-repository.ts'
import {
  calculateProxyReviewHash,
  type ProxyQualityIssue,
  type ProxyReview,
  type ProxyOutputFormat,
} from '../../application/render-workflow.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../domain/output-spec.ts'
import { outputVariantsOf } from '../../domain/output-consumption.ts'
import { readStoredOutputStateV3 } from './output-state-consumption.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { mp4EvidenceSealMismatches, type Mp4EvidenceSealV1 } from '../../domain/mp4-pixel-quality.ts'
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
    if ((candidate.outputPresetHash !== undefined &&
        (typeof candidate.outputPresetHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.outputPresetHash))) ||
        !geometryHash(candidate.placementPlanHash) || !geometryHash(candidate.reframePlanHash)) {
      throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} geometry hashes are invalid`)
    }
    if (candidate.format !== undefined && !OUTPUT_ASPECT_RATIOS.includes(candidate.format as ProxyOutputFormat)) {
      throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} output format is invalid`)
    }
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
      ...(candidate.outputPresetHash !== undefined ? { outputPresetHash: candidate.outputPresetHash as string } : {}),
      ...(candidate.placementPlanHash !== undefined ? { placementPlanHash: candidate.placementPlanHash as string | null } : {}),
      ...(candidate.reframePlanHash !== undefined ? { reframePlanHash: candidate.reframePlanHash as string | null } : {}),
      ...(candidate.format !== undefined ? { format: candidate.format as ProxyOutputFormat } : {}),
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

const MP4_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'reportSchemaVersion', 'reportHash', 'reportFileSha256', 'artifactSha256', 'artifactByteSize', 'renderInputHash', 'workspaceId', 'projectId',
  'projectVersionId', 'variantId', 'outputSpecId', 'operationId', 'policySha256', 'oracleModelDigests', 'sampledFrames', 'totalFrames', 'verdict',
].toSorted())

/** W67. The seal of the MP4 critic's report travels with the format verdict; it is read back exactly as it was written or the verdict is invalid. */
function parseMp4Evidence(value: unknown): Readonly<Mp4EvidenceSealV1> | undefined {
  if (value === undefined) return undefined
  const seal = value as Record<string, unknown>
  const digests = seal?.oracleModelDigests
  if (
    typeof seal !== 'object' || seal === null || Array.isArray(seal) || Object.keys(seal).toSorted().join('|') !== MP4_EVIDENCE_KEYS.join('|') ||
    !Array.isArray(digests) || digests.length < 1 || digests.length > 8 ||
    digests.some((entry) => typeof entry !== 'object' || entry === null || Object.keys(entry).toSorted().join('|') !== 'binSha256|id|scoreFloor|xmlSha256' ||
      typeof entry.id !== 'string' || typeof entry.scoreFloor !== 'number' || !/^[a-f0-9]{64}$/.test(String(entry.xmlSha256)) || !/^[a-f0-9]{64}$/.test(String(entry.binSha256))) ||
    mp4EvidenceSealMismatches(seal as unknown as Mp4EvidenceSealV1).length > 0 ||
    !Number.isSafeInteger(seal.artifactByteSize) || !Number.isSafeInteger(seal.sampledFrames) || !Number.isSafeInteger(seal.totalFrames) ||
    !['passed', 'warning', 'blocked'].includes(String(seal.verdict))
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy MP4 evidence seal is invalid')
  return Object.freeze({ ...(seal as unknown as Mp4EvidenceSealV1) })
}

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
    !geometryHash(candidate.placementPlanHash) || !geometryHash(candidate.reframePlanHash) ||
    (candidate.subtitleOverridesHash !== undefined && !geometryHash(candidate.subtitleOverridesHash))
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy format quality verdict is invalid')
  return Object.freeze({
    outputPresetHash: candidate.outputPresetHash,
    placementPlanHash: (candidate.placementPlanHash ?? null) as string | null,
    reframePlanHash: (candidate.reframePlanHash ?? null) as string | null,
    status: candidate.status as 'passed' | 'warning' | 'blocked',
    exportAllowed: candidate.exportAllowed,
    explanation: candidate.explanation,
    reportHash: candidate.reportHash,
    ...(candidate.mp4Evidence !== undefined ? { mp4Evidence: parseMp4Evidence(candidate.mp4Evidence)! } : {}),
    ...(typeof candidate.subtitleOverridesHash === 'string' ? { subtitleOverridesHash: candidate.subtitleOverridesHash } : {}),
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

/**
 * W70 readiness. Where a review's render was carried from, when it was carried (the operation names the review it came from and the hash that
 * review had); `null` for a render made for this Version. The decision that re-bound the approval is looked up by the review, never assumed, and
 * the time it was made is the time of the automatic acknowledgement the review shows.
 */
async function readCarry(
  client: Pick<Prisma.TransactionClient, 'v2ProjectProxyRenderOperation' | 'v2ProxyReviewDecision'>,
  row: Pick<StoredProxyReview, 'id' | 'workspaceId' | 'operationId'>,
): Promise<Readonly<{ carriedFrom: Omit<ProxyReviewCarriedFrom, 'acknowledgedBy'>; decidedAt: Date | null }> | null> {
  const operation = await client.v2ProjectProxyRenderOperation.findFirst({
    where: { operationId: row.operationId, workspaceId: row.workspaceId },
    select: { carriedFromReviewId: true, carriedFromReviewHash: true, reuseBaseVersionId: true, renderContentHash: true },
  })
  if (!operation || operation.carriedFromReviewId === null) return null
  if (operation.carriedFromReviewHash === null || operation.reuseBaseVersionId === null || operation.renderContentHash === null) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy review carry-over is incomplete')
  }
  const decision = await client.v2ProxyReviewDecision.findFirst({
    where: { workspaceId: row.workspaceId, proxyReviewId: row.id, action: 'carry-over-approval' },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return Object.freeze({
    carriedFrom: {
      versionId: operation.reuseBaseVersionId,
      reviewId: operation.carriedFromReviewId,
      reviewHash: operation.carriedFromReviewHash,
      decisionId: decision?.id ?? null,
      renderContentHash: operation.renderContentHash,
    },
    decidedAt: decision?.createdAt ?? null,
  })
}

/**
 * A hydrated review with the carry it came from, when it came from one.
 *
 * W70 readiness (Opus validation, note 3). The row of a review whose approval the carry re-bound holds the acknowledgement of the person who
 * acknowledged the SOURCE review (the database requires an acknowledged review to name an API client). That person did not acknowledge this
 * Version, so it is not published as the review's acknowledgement: it moves into `carriedFrom.acknowledgedBy`, and the review's own
 * acknowledgement is the automatic carry - its `carry-over-approval` decision and the time it was made. A person who acknowledged a carried
 * review that the carry did NOT approve did it on this Version, and stays the review's acknowledgement.
 */
async function withCarriedFrom(
  client: Pick<Prisma.TransactionClient, 'v2ProjectProxyRenderOperation' | 'v2ProxyReviewDecision'>,
  row: StoredProxyReview,
): Promise<Readonly<PersistedProxyReview>> {
  const review = hydrateProxyReview(row)
  const carry = await readCarry(client, row)
  if (!carry) return review
  if (carry.carriedFrom.decisionId === null || carry.decidedAt === null) {
    return Object.freeze({ ...review, carriedFrom: Object.freeze({ ...carry.carriedFrom, acknowledgedBy: null }) })
  }
  const original = review.acknowledgedBy
  if (!original || original.type !== 'api-client' || !review.warningsAcknowledged) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy review carry-over approval names no acknowledgement')
  }
  return Object.freeze({
    ...review,
    acknowledgedBy: Object.freeze({ type: 'automatic-carry' as const, id: carry.carriedFrom.decisionId, at: carry.decidedAt.toISOString() }),
    carriedFrom: Object.freeze({ ...carry.carriedFrom, acknowledgedBy: original }),
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

export async function readCurrentProxyReview(
  client: Pick<Prisma.TransactionClient, 'v2ProxyReview' | 'v2Project' | '$queryRawUnsafe' | 'v2ProjectProxyRenderOperation' | 'v2ProxyReviewDecision'>,
  input: Parameters<ProxyReviewRepository['findCurrent']>[0],
): Promise<Readonly<PersistedProxyReview> | null> {
  // The Version, then its sealed State: which output's review is asked for is decided by the State, never by recency.
  const versionId = input.projectVersionId ?? (await client.v2Project.findFirst({
    where: { id: input.projectId, workspaceId: input.workspaceId }, select: { currentVersionId: true },
  }))?.currentVersionId ?? undefined
  if (!versionId) return null
  const stored = await readStoredOutputStateV3(client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId })
  if (!stored) return null
  const variants = outputVariantsOf(stored.state)
  if (variants.length === 0) return null
  if (input.variantId === undefined && variants.length > 1) {
    throw new DomainError('PRECONDITION_REQUIRED', 'The Version has several outputs and the request names none', { reason: 'output-variant-required' })
  }
  if (input.variantId !== undefined && !variants.some((variant) => variant.variantId === input.variantId)) {
    throw new DomainError('PRECONDITION_REQUIRED', 'Requested stable variant is not an exact State member', { reason: 'output-variant-unknown' })
  }
  const variantId = input.variantId ?? variants[0]!.variantId
  const row = await client.v2ProxyReview.findFirst({
    where: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: versionId,
      // A review belongs to the output of the render that produced it; an unattributed (legacy) one only to a sole output.
      operation: variants.length === 1
        ? { OR: [{ outputVariantId: variantId }, { outputVariantId: null }] }
        : { outputVariantId: variantId },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  return row ? withCarriedFrom(client, row) : null
}

export class PrismaProxyReviewRepository implements ProxyReviewRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async persistGenerated(input: Parameters<ProxyReviewRepository['persistGenerated']>[0]) {
    return this.client.$transaction(
      (transaction) => this.persistGeneratedInTransaction(transaction, input),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  }

  async persistGeneratedInTransaction(
    transaction: Prisma.TransactionClient,
    input: Parameters<ProxyReviewRepository['persistGenerated']>[0],
  ): Promise<Readonly<PersistedProxyReview>> {
    return this.persistGeneratedScopedInTransaction(transaction, input, null)
  }

  async persistRenderableSnapshotInTransaction(
    transaction: Prisma.TransactionClient,
    input: Parameters<ProxyReviewRepository['persistGenerated']>[0],
    binding: Readonly<{ planId: string; planHash: string }>,
  ): Promise<Readonly<PersistedProxyReview>> {
    const detail = await transaction.v2ProjectProxyRenderOperation.findUnique({
      where: { operationId: input.operationId },
    })
    const snapshot = await transaction.v2RenderablePlanSnapshot.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId,
        projectVersionId: input.review.projectVersionId,
        planId: binding.planId, planHash: binding.planHash },
    })
    if (!detail || !snapshot || detail.workspaceId !== input.workspaceId ||
        detail.projectId !== input.projectId ||
        detail.projectVersionId !== input.review.projectVersionId ||
        detail.renderablePlanId !== binding.planId ||
        detail.renderablePlanHash !== binding.planHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot review binding is invalid')
    }
    return this.persistGeneratedScopedInTransaction(transaction, input, binding)
  }

  private async persistGeneratedScopedInTransaction(
    transaction: Prisma.TransactionClient,
    input: Parameters<ProxyReviewRepository['persistGenerated']>[0],
    renderableSnapshot: Readonly<{ planId: string; planHash: string }> | null,
  ): Promise<Readonly<PersistedProxyReview>> {
      const existing = await transaction.v2ProxyReview.findUnique({
        where: { operationId: input.operationId },
      })
      if (existing) {
        if (
          existing.workspaceId !== input.workspaceId ||
          existing.projectId !== input.projectId ||
          existing.projectVersionId !== input.review.projectVersionId ||
          existing.proxyArtifactId !== input.review.proxyArtifactId ||
          existing.proxyManifestId !== input.review.proxyManifestId ||
          existing.inputHash !== input.review.inputHash ||
          existing.outputSpecId !== input.review.outputSpecId ||
          existing.rangeCacheKey !== input.review.rangeCacheKey ||
          existing.specJson !== stableSerialize(input.review.spec) ||
          existing.status !== input.review.status ||
          existing.technicalIssuesJson !== stableSerialize(input.review.technicalIssues) ||
          existing.criticIssuesJson !== stableSerialize(input.review.criticIssues) ||
          existing.formatQualityJson !== (input.review.formatQuality ? stableSerialize(input.review.formatQuality) : null) ||
          existing.warningsAcknowledged !== input.review.warningsAcknowledged ||
          existing.finalAllowed !== input.review.finalAllowed ||
          existing.uploadReceivedAt.toISOString() !== input.review.uploadReceivedAt
        ) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review identity did not converge')
        // Render completion latency is observation metadata and may differ when
        // a durable operation retries after the review was committed but before
        // later side effects settle. The operation-bound review is otherwise
        // byte-for-byte equivalent, so its first persisted observation wins.
        return hydrateProxyReview(existing)
      }
      const createdAt = new Date(input.createdAt)
      if (Number.isNaN(createdAt.getTime())) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review creation time is invalid')
      await transaction.$queryRaw`SELECT id FROM public_operations WHERE id = ${input.operationId} FOR UPDATE`
      const operation = await transaction.v2PublicOperation.findUnique({ where: { id: input.operationId }, include: { projectProxyRender: true } })
      const now = input.lease ? new Date(input.lease.now) : createdAt
      const activeLease = operation?.status === 'running' && input.lease &&
        operation.leaseOwner === input.lease.owner && operation.attempt === input.lease.attempt &&
        operation.leaseExpiresAt !== null && operation.leaseExpiresAt.getTime() > now.getTime()
      const inlineReuse = operation?.status === 'succeeded' && input.lease === undefined &&
        operation.projectProxyRender?.reusedFromOperationId !== null &&
        operation.projectProxyRender?.reusedFromOperationId !== undefined
      if (!operation || operation.type !== 'project-proxy-render' || operation.workspaceId !== input.workspaceId ||
        operation.projectId !== input.projectId || operation.projectProxyRender?.projectVersionId !== input.review.projectVersionId ||
        (!activeLease && !inlineReuse) || Number.isNaN(now.getTime())) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy review cannot publish without the current worker lease or completed inline reuse')
      }
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
      const project = renderableSnapshot ? { count: await transaction.v2Project.count({
        where: { id: input.projectId, workspaceId: input.workspaceId },
      }) } : await transaction.v2Project.updateMany({
        where: {
          id: input.projectId,
          workspaceId: input.workspaceId,
          currentVersionId: input.review.projectVersionId,
          publicOperations: { none: {
            type: 'project-proxy-render',
            // A newer render supersedes this review only when it is for the SAME output: the other outputs' renders of one Version
            // are siblings (a legacy operation, made for no stated output, is superseded by any newer render of the Version).
            projectProxyRender: { is: { projectVersionId: input.review.projectVersionId,
              ...(operation.projectProxyRender?.outputVariantId ? { outputVariantId: operation.projectProxyRender.outputVariantId } : {}) } },
            OR: [{ createdAt: { gt: operation.createdAt } }, { createdAt: operation.createdAt, id: { gt: operation.id } }],
          } },
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
  }

  async findCurrent(input: Parameters<ProxyReviewRepository['findCurrent']>[0]) {
    return readCurrentProxyReview(this.client, input)
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
            review: await withCarriedFrom(transaction, review),
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
          review: await withCarriedFrom(transaction, review),
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
