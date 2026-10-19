import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { planProjectReframeService, readVariantReframePlanService } from '@/v2/application/plan-project-reframe'
import { DomainError } from '@/v2/domain/errors'
import { createFaceSourceWindowRepository, createVariantReframePlanRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseReframePlanRequest } from '@/v2/public-api/reframe-plan-contract'

export const dynamic = 'force-dynamic'

/** The latest persisted plan of one output variant (the head Version unless `projectVersionId` names another). It plans nothing. */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const variantId = request.nextUrl.searchParams.get('variantId') ?? ''
    const projectVersionId = request.nextUrl.searchParams.get('projectVersionId') ?? undefined
    const result = await readVariantReframePlanService({ plans: createVariantReframePlanRepository() })({
      workspaceId: actor.workspaceId, projectId, variantId, ...(projectVersionId !== undefined ? { projectVersionId } : {}),
    })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseReframePlanRequest(raw)
    const { projectId } = await context.params
    const plan = await planProjectReframeService({ plans: createVariantReframePlanRepository(), faceEvidence: createFaceSourceWindowRepository() })({
      workspaceId: actor.workspaceId, projectId, ...body,
    })
    return NextResponse.json(presentSuccess(plan), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
