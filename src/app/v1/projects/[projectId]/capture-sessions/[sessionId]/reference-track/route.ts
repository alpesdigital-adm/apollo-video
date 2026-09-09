import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { changeCaptureReferenceTrackService } from '@/v2/application/capture-session'
import { DomainError } from '@/v2/domain/errors'
import { createCaptureSessionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  parseChangeReferenceTrackBody,
  presentCaptureSessionSummary,
} from '@/v2/public-api/capture-session-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * Re-anchor the session on a different track.
 *
 * This is the one capture command that requires human approval, because it
 * changes what "time" means for every other track and makes every existing map,
 * coverage and diagnostic stale at once. The response carries the derivations
 * it invalidated, so a caller learns what it has to recompute rather than
 * discovering it from a map that quietly no longer applies.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
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
    const body = parseChangeReferenceTrackBody(rawBody)
    const result = await changeCaptureReferenceTrackService({
      repository: createCaptureSessionRepository(),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, clientId: actor.clientId },
      sessionId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      referenceTrackId: body.referenceTrackId,
      lineage: body.lineage,
    })
    return NextResponse.json(
      presentSuccess({
        session: presentCaptureSessionSummary(result.session),
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
