import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { proposeReviewPatchBatchService } from '@/v2/application/review-patch-batch'
import { DomainError } from '@/v2/domain/errors'
import { createReviewPatchBatchRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentReviewPatchBatch } from '@/v2/public-api/collaborative-review-presenters'

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
    if (Object.keys(record).some((key) => !['proposalIds', 'mode'].includes(key))) throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    if (!Array.isArray(record.proposalIds) || !record.proposalIds.every((value) => typeof value === 'string') ||
      (record.mode !== undefined && record.mode !== 'all-or-nothing' && record.mode !== 'partial-retry')) {
      throw new DomainError('INVALID_ARGUMENT', 'Patch batch body is invalid')
    }
    const { projectId } = await context.params
    const result = await proposeReviewPatchBatchService({
      repository: createReviewPatchBatchRepository(),
      clock: () => new Date(),
      createId: (kind) => kind === 'patch' ? `patch-${randomUUID()}` : randomUUID(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      proposalIds: record.proposalIds as string[],
      ...(record.mode ? { mode: record.mode as 'all-or-nothing' | 'partial-retry' } : {}),
      actor,
      idempotencyKey,
    })
    return NextResponse.json(presentSuccess({ batch: presentReviewPatchBatch(result.batch), replayed: result.replayed }), {
      status: result.replayed ? 200 : 201,
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
