import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMediaSegmentDerivativeRequestService } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ segmentId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:write')
    assertExternalMutationOrigin(request, actor)
    const body: unknown = await request.json().catch(() => { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') })
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'consumerKey,requiresPhysicalDerivative' || !('consumerKey' in body) || !('requiresPhysicalDerivative' in body) || typeof body.consumerKey !== 'string' || typeof body.requiresPhysicalDerivative !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'Request requires consumerKey and requiresPhysicalDerivative')
    const { segmentId } = await context.params
    const result = await createMediaSegmentDerivativeRequestService()({ workspaceId: actor.workspaceId, segmentId, consumerKey: body.consumerKey, requiresPhysicalDerivative: body.requiresPhysicalDerivative, idempotencyKey: request.headers.get('idempotency-key') ?? '', actor })
    return NextResponse.json(presentSuccess(result), { status: result.kind === 'job' && !result.replayed ? 202 : 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
