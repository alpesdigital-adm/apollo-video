import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createReactPlaybackMapServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parsePlaybackAnchorBody,
  presentAnchoredPlaybackMap,
} from '@/v2/public-api/react-playback-map-contract'

export const dynamic = 'force-dynamic'

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
    // The fence is in the body because it is part of what the caller asserts:
    // "I placed this anchor while looking at exactly this version of the map."
    // The evidence ref the aggregate writes is the authenticated actor plus the
    // note, never the note alone.
    const body = parsePlaybackAnchorBody(rawBody)
    const result = await createReactPlaybackMapServices().anchor({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      reactionTrackId: body.reactionTrackId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      anchor: body.anchor,
    })
    return NextResponse.json(
      presentSuccess(presentAnchoredPlaybackMap(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
