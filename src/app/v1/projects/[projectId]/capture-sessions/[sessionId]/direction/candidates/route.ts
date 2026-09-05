import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMulticamDirectionReadServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  identifier,
  integerParameter,
  tickParameter,
} from '@/v2/public-api/capture-derivation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentAngleCandidateListing } from '@/v2/public-api/multicam-direction-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const FILTERS = ['version', 'startTicks', 'endTicks', 'trackId', 'limit']

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
    const rawTrackId = params.get('trackId')
    // Ticks are parsed here rather than by `Number`: a 64-bit session tick
    // through a double comes back rounded, and the window it selects would be
    // the wrong window.
    const startTicks = tickParameter(params.get('startTicks'), 'startTicks')
    const endTicks = tickParameter(params.get('endTicks'), 'endTicks')
    const limit = integerParameter(params.get('limit'), 'limit', 1, 200)
    const result = await createMulticamDirectionReadServices().listCandidates({
      workspaceId: actor.workspaceId,
      sessionId,
      ...(rawVersion === null ? {} : { version: Number(rawVersion) }),
      ...(startTicks === undefined ? {} : { startTicks }),
      ...(endTicks === undefined ? {} : { endTicks }),
      ...(rawTrackId === null ? {} : { trackId: identifier(rawTrackId, 'trackId') }),
      ...(limit === undefined ? {} : { limit }),
    })
    return NextResponse.json(
      presentSuccess(presentAngleCandidateListing(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
