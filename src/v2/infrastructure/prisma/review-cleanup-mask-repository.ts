import type { Prisma, PrismaClient, V2ReviewCleanupMask } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedReviewCleanupMask,
  ReviewCleanupMaskRepository,
} from '../../application/ports/review-cleanup-mask-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertReviewCleanupMask,
  type ReviewCleanupMask,
} from '../../domain/review-cleanup-mask.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function parseMask(row: V2ReviewCleanupMask): Readonly<ReviewCleanupMask> {
  try {
    const mask = assertReviewCleanupMask(JSON.parse(row.maskJson) as ReviewCleanupMask)
    const keyframesJson = stableSerialize(mask.keyframes)
    const preserveRegionsJson = stableSerialize(mask.preserveRegions)
    const formatChangeJson = mask.formatChange ? stableSerialize(mask.formatChange) : null
    if (
      mask.id !== row.id || mask.maskHash !== row.maskHash || mask.workspaceId !== row.workspaceId ||
      mask.projectId !== row.projectId || mask.projectVersionId !== row.projectVersionId ||
      mask.rootId !== row.rootId || mask.revision !== row.revision || (mask.supersedesId ?? null) !== row.supersedesId ||
      mask.annotationId !== row.annotationId || mask.annotationHash !== row.annotationHash ||
      mask.proxyArtifactId !== row.proxyArtifactId || mask.proxyHash !== row.proxyHash ||
      mask.sourceArtifactId !== row.sourceArtifactId || mask.sourceArtifactHash !== row.sourceArtifactHash ||
      mask.transformationBriefId !== row.transformationBriefId || mask.transformationBriefHash !== row.transformationBriefHash ||
      mask.createdByClientId !== row.createdByClientId || mask.createdAt !== row.createdAt.toISOString() ||
      calculateCanonicalHash(mask.keyframes) !== row.keyframesHash || keyframesJson !== row.keyframesJson ||
      calculateCanonicalHash(mask.preserveRegions) !== row.preserveRegionsHash || preserveRegionsJson !== row.preserveRegionsJson ||
      (formatChangeJson ? calculateCanonicalHash(mask.formatChange) : null) !== row.formatChangeHash || formatChangeJson !== row.formatChangeJson
    ) throw new Error('projection mismatch')
    return mask
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored review cleanup mask is inconsistent')
  }
}

function hydrate(row: V2ReviewCleanupMask): Readonly<PersistedReviewCleanupMask> {
  return Object.freeze({
    mask: parseMask(row),
    authenticationAudit: hydrateExternalActorAudit(row, row.createdByClientId),
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
  })
}

export class PrismaReviewCleanupMaskRepository implements ReviewCleanupMaskRepository {
  constructor(private readonly client: PrismaClient) {}

  async findIdempotent(input: { workspaceId: string; projectId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string }) {
    const row = await this.client.v2ReviewCleanupMask.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, createdByClientId: input.actorClientId, idempotencyKey: input.idempotencyKey },
    })
    if (!row) return null
    const persisted = hydrate(row)
    if (persisted.authenticationAudit.contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Cleanup mask idempotency key belongs to another authentication context')
    }
    return persisted
  }

  async read(input: { workspaceId: string; projectId: string; maskId: string }) {
    const row = await this.client.v2ReviewCleanupMask.findFirst({ where: { id: input.maskId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? hydrate(row) : null
  }

  async readLatest(input: { workspaceId: string; projectId: string; rootId: string }) {
    const row = await this.client.v2ReviewCleanupMask.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, rootId: input.rootId },
      orderBy: [{ revision: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrate(row) : null
  }

  async list(input: { workspaceId: string; projectId: string; projectVersionId?: string; limit: number }) {
    const rows = await this.client.v2ReviewCleanupMask.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }

  async persist(input: { mask: Readonly<ReviewCleanupMask>; authenticationAudit: PersistedReviewCleanupMask['authenticationAudit']; idempotencyKey: string; requestFingerprint: string }) {
    const mask = assertReviewCleanupMask(input.mask)
    try {
      return await this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
        const existing = await transaction.v2ReviewCleanupMask.findFirst({
          where: { workspaceId: mask.workspaceId, projectId: mask.projectId, createdByClientId: mask.createdByClientId, idempotencyKey: input.idempotencyKey },
        })
        if (existing) {
          const persisted = hydrate(existing)
          if (persisted.requestFingerprint !== input.requestFingerprint || persisted.authenticationAudit.contextHash !== input.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Cleanup mask idempotency payload changed')
          }
          return persisted
        }
        const project = await transaction.v2Project.findFirst({ where: { id: mask.projectId, workspaceId: mask.workspaceId }, select: { currentVersionId: true } })
        if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
        if (project.currentVersionId !== mask.projectVersionId) throw new DomainError('VERSION_CONFLICT', 'Project version changed before cleanup mask persistence')
        if (mask.supersedesId) {
          const prior = await transaction.v2ReviewCleanupMask.findFirst({ where: { id: mask.supersedesId, workspaceId: mask.workspaceId, projectId: mask.projectId } })
          if (!prior || prior.rootId !== mask.rootId || prior.revision + 1 !== mask.revision || prior.maskHash === mask.maskHash) {
            throw new DomainError('VERSION_CONFLICT', 'Cleanup mask revision no longer follows its persisted predecessor')
          }
          const latest = await transaction.v2ReviewCleanupMask.findFirst({ where: { workspaceId: mask.workspaceId, projectId: mask.projectId, rootId: mask.rootId }, orderBy: { revision: 'desc' } })
          if (latest?.id !== prior.id) throw new DomainError('VERSION_CONFLICT', 'Cleanup mask was refined concurrently')
        }
        const row = await transaction.v2ReviewCleanupMask.create({
          data: {
            id: mask.id, workspaceId: mask.workspaceId, projectId: mask.projectId, projectVersionId: mask.projectVersionId,
            rootId: mask.rootId, revision: mask.revision, supersedesId: mask.supersedesId ?? null,
            schemaVersion: mask.schemaVersion, policyVersion: mask.policyVersion,
            annotationId: mask.annotationId, annotationHash: mask.annotationHash,
            proxyArtifactId: mask.proxyArtifactId, proxyHash: mask.proxyHash,
            sourceArtifactId: mask.sourceArtifactId, sourceArtifactHash: mask.sourceArtifactHash,
            transformationBriefId: mask.transformationBriefId, transformationBriefHash: mask.transformationBriefHash,
            outputSpecId: mask.format.outputSpecId, formatWidth: mask.format.width, formatHeight: mask.format.height,
            rangeStartFrame: mask.range.startFrame, rangeEndFrame: mask.range.endFrame,
            regionX: mask.region.x, regionY: mask.region.y, regionWidth: mask.region.width, regionHeight: mask.region.height,
            keyframesJson: stableSerialize(mask.keyframes), keyframesHash: calculateCanonicalHash(mask.keyframes),
            preserveRegionsJson: stableSerialize(mask.preserveRegions), preserveRegionsHash: calculateCanonicalHash(mask.preserveRegions),
            trackingStatus: mask.tracking.status, trackingConfidenceBps: mask.tracking.confidenceBps,
            formatChangeJson: mask.formatChange ? stableSerialize(mask.formatChange) : null,
            formatChangeHash: mask.formatChange ? calculateCanonicalHash(mask.formatChange) : null,
            createdByClientId: mask.createdByClientId,
            ...externalActorAuditData(input.authenticationAudit, mask.workspaceId, mask.createdByClientId),
            idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint,
            createdAt: new Date(mask.createdAt), maskJson: stableSerialize(mask), maskHash: mask.maskHash,
          },
        })
        return hydrate(row)
      })
    } catch (error) {
      if (error instanceof DomainError) throw error
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new DomainError('VERSION_CONFLICT', 'Cleanup mask revision or identity already exists')
      throw error
    }
  }
}
