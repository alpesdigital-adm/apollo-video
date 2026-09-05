import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createReactPlaybackMapReadServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { identifier, integerParameter } from '@/v2/public-api/capture-derivation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parsePlaybackMode,
  presentPlaybackPieceListing,
} from '@/v2/public-api/react-playback-map-contract'

export const dynamic = 'force-dynamic'

const FILTERS = ['reactionTrackId', 'version', 'mode', 'limit']

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (!FILTERS.includes(name) || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const { sessionId } = await context.params
    const rawVersion = params.get('version')
    const mode = parsePlaybackMode(params.get('mode'))
    const limit = integerParameter(params.get('limit'), 'limit', 1, 500)
    const result = await createReactPlaybackMapReadServices().listPieces({
      workspaceId: actor.workspaceId,
      sessionId,
      reactionTrackId: identifier(params.get('reactionTrackId'), 'reactionTrackId'),
      ...(rawVersion === null ? {} : { version: Number(rawVersion) }),
      ...(mode === undefined ? {} : { mode }),
      ...(limit === undefined ? {} : { limit }),
    })
    return NextResponse.json(
      presentSuccess(presentPlaybackPieceListing(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
