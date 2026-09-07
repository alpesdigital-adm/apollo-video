import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createSynthesisRenderPlanService } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseCompileSynthesisPlanBody,
  presentCompiledRenderablePlan,
} from '@/v2/public-api/renderable-plan-contract'

export const dynamic = 'force-dynamic'

/**
 * Compile the synthesis into the plan a renderer accepts (F4.016 condition 6).
 *
 * `createSynthesisRenderPlanService` was assembled in the composition root and
 * called by nothing: a two-hour master could be cut to two minutes through
 * `POST /v1/projects/{projectId}/editorial-syntheses` and then had nowhere to
 * go, because the bridge to a renderable plan had no address. The gate reads
 * the row this writes.
 *
 * The caller brings the project version the plan belongs to and what the cut is
 * for. It brings no source, no digest and no duration: the masters are resolved
 * through the media links the project carries, which is the lookup the render
 * path performs, and a master whose bytes are no longer the ones the ranges
 * were selected from is refused rather than quoted.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; synthesisId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId, synthesisId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseCompileSynthesisPlanBody(rawBody)
    const result = await createSynthesisRenderPlanService()({
      workspaceId: actor.workspaceId,
      projectId,
      synthesisId,
      projectVersionId: body.projectVersionId,
      objective: body.objective,
    })
    return NextResponse.json(
      presentSuccess(presentCompiledRenderablePlan(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
