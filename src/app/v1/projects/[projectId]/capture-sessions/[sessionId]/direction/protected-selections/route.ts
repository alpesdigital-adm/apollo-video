import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createDirectMulticamSessionService } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseProtectMulticamSelectionBody,
  presentDirectedSession,
} from '@/v2/public-api/multicam-direction-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * Directing while holding a selection a person protected.
 *
 * The same service as `POST .../direction`, and a separate endpoint on purpose:
 * this body refuses an empty selection list, so "protect this shot" cannot
 * silently become "re-cut the session", and the agent-tool rule on the two
 * differs because one of them puts a person's judgement over a measurement.
 */
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
    // The note is the operator's; `attestedBy` is never a request field. The
    // service concatenates the authenticated actor with the note, so who moved
    // the shot is recorded and not only what they said about it.
    const body = parseProtectMulticamSelectionBody(rawBody)
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    const result = await createDirectMulticamSessionService()({
      workspaceId: actor.workspaceId,
      projectId,
      sessionId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      format: body.format,
      ...(body.range ? { range: body.range } : {}),
      ...(body.policy ? { policy: body.policy } : {}),
      ...(body.protectedSelections ? { protectedSelections: body.protectedSelections } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
      idempotency: { clientId: actor.clientId, key: idempotencyKey },
    })
    return NextResponse.json(
      presentSuccess({ directed: presentDirectedSession(result), replayed: result.replayed }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
