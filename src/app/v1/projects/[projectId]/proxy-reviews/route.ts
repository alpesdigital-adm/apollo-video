import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  acknowledgeProxyWarningsService,
  readProxyReviewService,
} from '@/v2/application/proxy-review'
import { DomainError } from '@/v2/domain/errors'
import { createProxyReviewRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentProxyReview } from '@/v2/public-api/proxy-review-presenter'

export const dynamic = 'force-dynamic'

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
    // The stable State variant of the output whose review is read; optional only for a Version with exactly one output.
    const variantId = request.nextUrl.searchParams.get('variantId')?.trim() || undefined
    const review = await readProxyReviewService({
      repository: createProxyReviewRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
      ...(variantId ? { variantId } : {}),
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
