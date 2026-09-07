import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createReactPlaybackMapServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseCompilePlaybackPlanBody,
  presentCompiledRenderablePlan,
} from '@/v2/public-api/renderable-plan-contract'

export const dynamic = 'force-dynamic'

/**
 * Compile the map into the plan a renderer accepts (F4.015).
 *
 * The hop that had no address. `playback-map`, `playback-map/pieces` and
 * `playback-map/anchors` published the whole of the react edit except the one
 * step that produces something renderable, so the only writer of a
 * `renderable_plan_snapshots` row for this origin was a test reaching past the
 * API into the composition root — and the F4.016 gate reads exactly that row
 * for `map-compiled-into-plan`.
 *
 * The request names the map version it read and the frame rate to deliver at.
 * Every frame number in the answer is derived from the stored map and from
 * durations the server measured on the files.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { sessionId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseCompilePlaybackPlanBody(rawBody)
    const result = await createReactPlaybackMapServices().compile({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      reactionTrackId: body.reactionTrackId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      projectVersionId: body.projectVersionId,
      objective: body.objective,
      planFps: body.planFps,
    })
    return NextResponse.json(
      presentSuccess(presentCompiledRenderablePlan(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
