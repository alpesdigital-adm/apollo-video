import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  acknowledgeProxyWarningsService,
  readProxyReviewService,
} from '@/v2/application/proxy-review'
import type { PersistedProxyReview } from '@/v2/application/ports/proxy-review-repository'
import { DomainError } from '@/v2/domain/errors'
import { createProxyReviewRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function presentProxyReview(review: Readonly<PersistedProxyReview>) {
  return {
    id: review.id,
    projectId: review.projectId,
    projectVersionId: review.projectVersionId,
    operationId: review.operationId,
    proxyArtifactId: review.proxyArtifactId,
    proxyManifestId: review.proxyManifestId,
    inputHash: review.inputHash,
    outputSpecId: review.outputSpecId,
    rangeCacheKey: review.rangeCacheKey,
    spec: review.spec,
    status: review.status,
    technicalIssues: review.technicalIssues,
    criticIssues: review.criticIssues,
    ...(review.formatQuality ? { formatQuality: review.formatQuality } : {}),
    warningsAcknowledged: review.warningsAcknowledged,
    finalAllowed: review.finalAllowed,
    uploadReceivedAt: review.uploadReceivedAt,
    renderCompletedAt: review.renderCompletedAt,
    timeToFirstProxyMs: review.timeToFirstProxyMs,
    reviewHash: review.reviewHash,
    revision: review.revision,
    ...(review.acknowledgedBy ? { acknowledgedBy: review.acknowledgedBy } : {}),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const projectVersionId = request.nextUrl.searchParams.get('projectVersionId')?.trim() || undefined
    const review = await readProxyReviewService({
      repository: createProxyReviewRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
    })
    return NextResponse.json(
      presentSuccess({ review: presentProxyReview(review) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:approve')
    const body = await request.json() as Record<string, unknown>
    if (Object.keys(body).some((key) => ![
      'action',
      'proxyReviewId',
      'projectVersionId',
      'baseRevision',
      'expectedRevision',
    ].includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    }
    if (
      body.action !== 'acknowledge-warnings' ||
      typeof body.proxyReviewId !== 'string' ||
      typeof body.projectVersionId !== 'string' ||
      typeof body.baseRevision !== 'string' ||
      !Number.isSafeInteger(body.expectedRevision)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'action, proxyReviewId, projectVersionId, baseRevision and expectedRevision are required',
      )
    }
    const { projectId } = await context.params
    const result = await acknowledgeProxyWarningsService({
      repository: createProxyReviewRepository(),
      clock: () => new Date(),
      createId: () => `proxy-review-decision-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: body.projectVersionId,
      proxyReviewId: body.proxyReviewId,
      baseReviewHash: body.baseRevision,
      expectedRevision: body.expectedRevision as number,
      action: 'acknowledge-warnings',
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        review: presentProxyReview(result.review),
        decision: result.decision,
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
