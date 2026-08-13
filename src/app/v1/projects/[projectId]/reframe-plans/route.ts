import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { planProjectReframeService } from '@/v2/application/plan-project-reframe'
import { DomainError } from '@/v2/domain/errors'
import { createDirectorRunRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseReframePlanRequest } from '@/v2/public-api/reframe-plan-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseReframePlanRequest(raw)
    const { projectId } = await context.params
    const plan = await planProjectReframeService({ projects: createDirectorRunRepository() })({
      workspaceId: actor.workspaceId, projectId, ...body,
    })
    return NextResponse.json(presentSuccess({ plan }), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
