import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { materializeActorAuditContext } from '../../application/authenticate-api-client.ts'
import type {
  ProxyCarryOverRepository,
  ProxyCarryOverRequest,
  ProxyCarryOverResult,
} from '../../application/ports/proxy-carry-over-repository.ts'
import { calculateProxyReviewHash, proxyRangeCacheKey, type ProxyReview } from '../../application/render-workflow.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../domain/public-operation.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { parseCommandImpact } from '../../domain/command-impact.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData } from './external-actor-audit.ts'
import { hydratePublicOperationRecord, OPERATION_INCLUDE, persistOperationStatusEvents } from './public-operation-repository.ts'
import { hydrateProxyReview } from './proxy-review-repository.ts'

const MAX_ANCESTOR_STEPS = 500

/**
 * The impact hash of the Command that made the head Version, read from the sealed payload it was committed with (every Command a carry follows
 * - a subtitle segment exception, a manual reframe - carries its impact there). `null` when it cannot be read: a carry is then not made, rather
 * than recorded under an impact nobody can show.
 */
async function commandImpactHashOf(transaction: Prisma.TransactionClient, scope: Readonly<{ workspaceId: string; projectId: string; commandId: string }>): Promise<string | null> {
  const command = await transaction.v2EditCommand.findFirst({ where: { id: scope.commandId, workspaceId: scope.workspaceId, projectId: scope.projectId }, select: { payloadJson: true } })
  if (!command) return null
  try {
    const payload = JSON.parse(command.payloadJson) as { impact?: unknown }
    return parseCommandImpact(payload.impact).impactHash
  } catch {
    return null
  }
}

/**
 * W70 prep. Carries the render, the review and the approval of ONE output from an earlier Version of the project to its head Version, in one
 * Serializable transaction, when the earlier render's stored content address is exactly the one the head's output has now.
 *
 * What is written for the head Version and the output (and nothing else):
 *  - a completed `project-proxy-render` operation that points at the SAME artifact and manifest, with the `reusedFrom*` columns naming the
 *    operation it was carried from, that operation's Version and the Command that made the head;
 *  - the render element map of that artifact, bound to the head Version (same bytes of content);
 *  - a review row: the earlier review with the head Version and input hash, and its own hash. A review whose warnings a person acknowledged is
 *    created as the pending review it was and then moved to `ready-for-final` by a decision of its own kind, `carry-over-approval`, which
 *    names the review it carries (`baseReviewHash`) and the content address that proved the inputs equal (`requestFingerprint`) - the
 *    approval is re-bound explicitly, with an actor, never copied silently. A review that needed no acknowledgement is copied as it was.
 * The project status is not touched.
 */
export class PrismaProxyCarryOverRepository implements ProxyCarryOverRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async carry(request: Readonly<ProxyCarryOverRequest>, attempt = 0): Promise<ProxyCarryOverResult> {
    try {
      return await this.client.$transaction((transaction) => this.carryInTransaction(transaction, request), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined
      if ((code === 'P2034' || code === 'P2002') && attempt < 2) return this.carry(request, attempt + 1)
      throw error
    }
  }

  private async carryInTransaction(transaction: Prisma.TransactionClient, request: Readonly<ProxyCarryOverRequest>): Promise<ProxyCarryOverResult> {
    const { workspaceId, projectId } = request
    // The head must still be the Version the output was read at: a carry to a Version that is no longer the head would write a render for nothing.
    const locked = await transaction.$queryRaw<{ currentVersionId: string | null }[]>(Prisma.sql`SELECT "currentVersionId" FROM "projects"
      WHERE "id" = ${projectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`)
    if (locked.length !== 1 || locked[0]!.currentVersionId !== request.toProjectVersionId) return { status: 'not-eligible', reason: 'head-moved' }

    const present = await transaction.v2ProjectProxyRenderOperation.findFirst({
      where: { workspaceId, projectId, projectVersionId: request.toProjectVersionId, OR: [{ inputHash: request.inputHash }, { outputVariantId: request.variantId, operation: { status: { in: ['queued', 'running', 'retrying', 'waiting', 'succeeded'] } } }] },
      select: { operationId: true },
    })
    if (present) return { status: 'present', operationId: present.operationId }

    // The newest completed render of this output, in an earlier Version, whose own content address is the one this output has now.
    const source = await transaction.v2ProjectProxyRenderOperation.findFirst({
      where: {
        workspaceId, projectId, outputVariantId: request.variantId, renderContentHash: request.renderContentHash,
        projectVersionId: { not: request.toProjectVersionId }, operation: { status: 'succeeded', phase: 'completed' },
      },
      orderBy: [{ createdAt: 'desc' }, { operationId: 'desc' }],
      include: { review: true },
    })
    if (!source) return { status: 'not-eligible', reason: 'no-source-render' }
    // ... and in an ANCESTOR of the head (a Version on the line the head descends from), never a sibling branch.
    let cursor: string | null = request.toProjectVersionId
    let ancestor = false
    for (let step = 0; step < MAX_ANCESTOR_STEPS && cursor !== null; step += 1) {
      const row: { parentVersionId: string | null } | null = await transaction.v2ProjectVersion.findFirst({ where: { id: cursor, workspaceId, projectId }, select: { parentVersionId: true } })
      if (!row) break
      if (row.parentVersionId === source.projectVersionId) { ancestor = true; break }
      cursor = row.parentVersionId
    }
    if (!ancestor) return { status: 'not-eligible', reason: 'source-not-ancestor' }

    const [artifact, manifest, map, version] = await Promise.all([
      transaction.v2MediaArtifact.findFirst({ where: { id: source.outputArtifactId, workspaceId, status: 'available' }, select: { id: true } }),
      transaction.v2MediaArtifactManifest.findFirst({ where: { id: source.outputManifestId, workspaceId, artifactId: source.outputArtifactId }, select: { id: true } }),
      transaction.v2RenderElementMap.findFirst({ where: { workspaceId, projectId, projectVersionId: source.projectVersionId, proxyArtifactId: source.outputArtifactId } }),
      transaction.v2ProjectVersion.findFirst({ where: { id: request.toProjectVersionId, workspaceId, projectId }, select: { commandId: true } }),
    ])
    if (!source.review || !artifact || !manifest || !map) return { status: 'not-eligible', reason: 'source-incomplete' }
    const sourceReview = hydrateProxyReview(source.review)
    // The Command that made the head, and the impact it was committed with: the carry is decided under THAT impact (the Command did not touch this
    // output) and records it where an impact belongs. Without both there is nothing to record, so nothing is carried.
    const carriedByCommandId = request.commandId ?? version?.commandId ?? null
    const commandImpactHash = carriedByCommandId ? await commandImpactHashOf(transaction, { workspaceId, projectId, commandId: carriedByCommandId }) : null
    if (!carriedByCommandId || !commandImpactHash) return { status: 'not-eligible', reason: 'command-impact-missing' }

    // ---- the operation: completed, pointing at the very same artifact
    const audit = materializeActorAuditContext(request.actor)
    let operation = createQueuedPublicOperation({
      id: request.ids.operation, workspaceId, projectId, clientId: audit.clientId, type: 'project-proxy-render',
      target: { type: 'media-artifact', id: source.outputArtifactId, manifestId: source.outputManifestId }, createdAt: request.now,
    })
    operation = startPublicOperationAttempt(operation, request.now)
    operation = advancePublicOperationPhase(operation, 'persisting', request.now)
    operation = succeedPublicOperation(operation, request.now)
    await transaction.v2PublicOperation.create({
      data: {
        id: operation.id, workspaceId, projectId, clientId: operation.clientId,
        actorCredentialId: audit.credentialId, actorEnvironment: audit.environment, actorAuthenticationKind: audit.authenticationKind,
        actorContextHash: audit.contextHash, delegatedUserId: audit.delegatedUserId, delegatedIdentityId: audit.delegatedIdentityId, workspaceRole: audit.workspaceRole,
        type: operation.type, status: operation.status, phase: operation.phase, targetType: operation.target.type, targetId: operation.target.id,
        progressCompleted: operation.progress?.completed, progressTotal: operation.progress?.total, progressUnit: operation.progress?.unit,
        cancelable: operation.cancelable, retryable: operation.retryable, attempt: operation.attempt, maxAttempts: operation.maxAttempts,
        idempotencyKey: `carry-over:${request.toProjectVersionId}:${request.variantId}`.slice(0, 128), requestFingerprint: request.renderContentHash,
        ...(request.traceId ? { traceId: request.traceId } : {}),
        createdAt: new Date(operation.createdAt), updatedAt: new Date(operation.updatedAt),
        ...(operation.result ? { resultJson: JSON.stringify(operation.result) } : {}),
        ...(operation.startedAt ? { startedAt: new Date(operation.startedAt) } : {}),
        ...(operation.completedAt ? { completedAt: new Date(operation.completedAt) } : {}),
      },
    })
    await transaction.v2ProjectProxyRenderOperation.create({
      data: {
        operationId: operation.id, workspaceId, projectId, projectVersionId: request.toProjectVersionId, editPlanSnapshotId: request.editPlanSnapshotId,
        sourceArtifactId: request.sourceArtifactId, sourceManifestId: request.sourceManifestId, colorPipelineBindingsJson: source.colorPipelineBindingsJson,
        inputHash: request.inputHash, outputArtifactId: source.outputArtifactId, outputManifestId: source.outputManifestId,
        originalFileName: request.originalFileName, outputVariantId: request.variantId, renderContentHash: request.renderContentHash,
        reusedFromOperationId: source.operationId, reuseBaseVersionId: source.projectVersionId,
        reuseCommandId: carriedByCommandId,
        // the impact of that Command; the content address that proved the inputs equal is `renderContentHash`, on this same row
        reuseImpactHash: commandImpactHash,
        // visible as what it is: carried from this review, which had this hash when it was carried (the public review's `carriedFrom`)
        carriedFromReviewId: source.review.id,
        carriedFromReviewHash: source.review.reviewHash,
      },
    })
    const created = await transaction.v2PublicOperation.findUnique({ where: { id: operation.id }, include: OPERATION_INCLUDE })
    if (!created) throw new DomainError('PERSISTENCE_CONFLICT', 'Carried PublicOperation was not persisted')
    await persistOperationStatusEvents(transaction, undefined, hydratePublicOperationRecord(created).operation, randomUUID)

    // ---- the cue map of the same MP4, bound to the head Version
    await transaction.v2RenderElementMap.create({
      data: {
        id: request.ids.map, workspaceId, projectId, projectVersionId: request.toProjectVersionId, proxyArtifactId: source.outputArtifactId,
        proxyHash: map.proxyHash, mapHash: map.mapHash, schemaVersion: map.schemaVersion, fps: map.fps, durationFrames: map.durationFrames,
        canvasWidth: map.canvasWidth, canvasHeight: map.canvasHeight, elementsJson: map.elementsJson, createdAt: new Date(request.now),
      },
    })

    // ---- the review, and the approval it had
    const acknowledged = sourceReview.warningsAcknowledged
    const rangeCacheKey = proxyRangeCacheKey({ projectVersionId: request.toProjectVersionId, ...request.rangeCache, spec: sourceReview.spec })
    const pending: Omit<ProxyReview, 'reviewHash'> = Object.freeze({
      schemaVersion: sourceReview.schemaVersion, projectVersionId: request.toProjectVersionId, proxyArtifactId: sourceReview.proxyArtifactId,
      proxyManifestId: sourceReview.proxyManifestId, inputHash: request.inputHash, outputSpecId: sourceReview.outputSpecId,
      rangeCacheKey, spec: sourceReview.spec,
      status: acknowledged ? 'warning-ack-required' : sourceReview.status,
      technicalIssues: sourceReview.technicalIssues, criticIssues: sourceReview.criticIssues,
      ...(sourceReview.formatQuality ? { formatQuality: sourceReview.formatQuality } : {}),
      warningsAcknowledged: false, finalAllowed: acknowledged ? false : sourceReview.finalAllowed,
      uploadReceivedAt: sourceReview.uploadReceivedAt, renderCompletedAt: sourceReview.renderCompletedAt, timeToFirstProxyMs: sourceReview.timeToFirstProxyMs,
    })
    const pendingHash = calculateProxyReviewHash(pending)
    const now = new Date(request.now)
    const review = await transaction.v2ProxyReview.create({
      data: {
        id: request.ids.review, workspaceId, projectId, projectVersionId: request.toProjectVersionId, operationId: operation.id,
        proxyArtifactId: source.outputArtifactId, proxyManifestId: source.outputManifestId, inputHash: request.inputHash, outputSpecId: pending.outputSpecId,
        rangeCacheKey, specJson: source.review.specJson, status: pending.status,
        technicalIssuesJson: source.review.technicalIssuesJson, criticIssuesJson: source.review.criticIssuesJson, formatQualityJson: source.review.formatQualityJson,
        warningsAcknowledged: false, finalAllowed: pending.finalAllowed, reviewHash: pendingHash, revision: 1,
        uploadReceivedAt: source.review.uploadReceivedAt, renderCompletedAt: source.review.renderCompletedAt, timeToFirstProxyMs: source.review.timeToFirstProxyMs,
        createdAt: now, updatedAt: now,
      },
    })
    let reviewHash = pendingHash
    if (acknowledged) {
      const approved: Omit<ProxyReview, 'reviewHash'> = Object.freeze({ ...pending, status: 'ready-for-final' as const, warningsAcknowledged: true, finalAllowed: true })
      reviewHash = calculateProxyReviewHash(approved)
      await transaction.v2ProxyReview.update({
        where: { id: review.id },
        data: {
          status: 'ready-for-final', warningsAcknowledged: true, finalAllowed: true, reviewHash, revision: { increment: 1 },
          acknowledgedByType: source.review.acknowledgedByType, acknowledgedById: source.review.acknowledgedById, acknowledgedAt: source.review.acknowledgedAt, updatedAt: now,
        },
      })
      await transaction.v2ProxyReviewDecision.create({
        data: {
          id: request.ids.decision, workspaceId, projectId, proxyReviewId: review.id, action: 'carry-over-approval', actorType: 'api-client', actorId: audit.clientId,
          ...externalActorAuditData(audit, workspaceId, audit.clientId),
          baseReviewHash: source.review.reviewHash, resultReviewHash: reviewHash,
          idempotencyKey: `carry-over-approval:${review.id}`.slice(0, 128), requestFingerprint: calculateCanonicalHash({
            kind: 'proxy-carry-over-approval/v1', renderContentHash: request.renderContentHash, fromReviewHash: source.review.reviewHash, toReviewHash: reviewHash,
          }),
          createdAt: now,
        },
      })
    }
    return {
      status: 'carried', operationId: operation.id, reviewId: review.id, fromProjectVersionId: source.projectVersionId, fromOperationId: source.operationId,
      fromReviewId: source.review.id, fromReviewHash: source.review.reviewHash, reviewHash, approvalCarried: acknowledged, outputArtifactId: source.outputArtifactId,
    }
  }
}
