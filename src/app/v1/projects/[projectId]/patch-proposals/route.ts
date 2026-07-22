import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { proposeReviewPatchService } from '@/v2/application/review-patch'
import { DomainError } from '@/v2/domain/errors'
import { createReviewPatchRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let body: unknown
    try { body = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) => !['annotationId', 'selectedChoiceId'].includes(key))) throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    if (typeof record.annotationId !== 'string' || (record.selectedChoiceId !== undefined && typeof record.selectedChoiceId !== 'string')) throw new DomainError('INVALID_ARGUMENT', 'Patch proposal body is invalid')
    const { projectId } = await context.params
    const result = await proposeReviewPatchService({
      repository: createReviewPatchRepository(),
      clock: () => new Date(),
      createId: (kind) => kind === 'review-patch-proposal' ? randomUUID() : `patch-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      annotationId: record.annotationId,
      ...(record.selectedChoiceId ? { selectedChoiceId: record.selectedChoiceId as string } : {}),
      idempotencyKey,
    })
    return NextResponse.json(presentSuccess({ proposal: result.proposal, replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
