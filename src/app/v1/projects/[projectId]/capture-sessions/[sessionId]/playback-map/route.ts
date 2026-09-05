import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import {
  createReactPlaybackMapReadServices,
  createReactPlaybackMapServices,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { identifier } from '@/v2/public-api/capture-derivation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseBuildPlaybackMapBody,
  presentBuiltPlaybackMap,
  presentPlaybackMapRead,
} from '@/v2/public-api/react-playback-map-contract'

export const dynamic = 'force-dynamic'

const FILTERS = ['reactionTrackId', 'version']

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
    const result = await createReactPlaybackMapReadServices().read({
      workspaceId: actor.workspaceId,
      sessionId,
      // Required, never guessed: a session with two reaction tracks is two
      // edits, and returning the first would answer about the wrong one.
      reactionTrackId: identifier(params.get('reactionTrackId'), 'reactionTrackId'),
      ...(rawVersion === null ? {} : { version: Number(rawVersion) }),
    })
    return NextResponse.json(
      presentSuccess(presentPlaybackMapRead(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

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
    // The session fence and which reactor. Every piece, mode, rate and residual
    // is read off the recordings by the fingerprinter; a request that could
    // contribute one could say the player never paused.
    const body = parseBuildPlaybackMapBody(rawBody)
    const result = await createReactPlaybackMapServices().build({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      ...(body.reactionTrackId ? { reactionTrackId: body.reactionTrackId } : {}),
    })
    return NextResponse.json(
      presentSuccess(presentBuiltPlaybackMap(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
