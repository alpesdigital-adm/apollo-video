import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import {
  createDeriveMulticamMatchPlanService,
  createMulticamMatchPlanReadService,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseDeriveMatchPlanBody,
  presentDerivedMatchPlan,
  presentMulticamMatchPlanRead,
} from '@/v2/public-api/multicam-color-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'version' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const rawVersion = params.get('version')
    const { projectId, sessionId } = await context.params
    const result = await createMulticamMatchPlanReadService()({
      workspaceId: actor.workspaceId,
      projectId,
      sessionId,
      ...(rawVersion === null ? {} : { version: Number(rawVersion) }),
    })
    return NextResponse.json(
      presentSuccess(presentMulticamMatchPlanRead(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId, sessionId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    // Which camera the others are corrected towards, and the two version pairs
    // that decision was made against. No delta, no confidence, no issue: the
    // service measures the cameras itself, and a request that could state a
    // delta could state that a camera matches when it does not.
    const body = parseDeriveMatchPlanBody(rawBody)
    const result = await createDeriveMulticamMatchPlanService()({
      workspaceId: actor.workspaceId,
      projectId,
      sessionId,
      referenceCameraId: body.referenceCameraId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      projectBaseVersionId: body.projectBaseVersionId,
      projectBaseHash: body.projectBaseHash,
      ...(body.note ? { note: body.note } : {}),
      actor,
    })
    return NextResponse.json(
      presentSuccess(presentDerivedMatchPlan(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
