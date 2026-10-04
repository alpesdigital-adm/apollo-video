import { NextRequest, NextResponse } from 'next/server'
import { requireScope, materializeActorAuditContext } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMediaSegmentDerivativeJobRepository } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:write'); assertExternalMutationOrigin(request, actor)
    const { jobId } = await context.params
    const job = await createMediaSegmentDerivativeJobRepository().retry(actor.workspaceId, jobId, materializeActorAuditContext(actor).contextHash, new Date())
    if (!job) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Derivative job was not found')
    return NextResponse.json(presentSuccess(job), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
