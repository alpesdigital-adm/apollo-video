import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readPublicEventFeedService } from '@/v2/application/read-public-event-feed'
import { createPublicEventFeedRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentPublicEventFeed, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    assertAllowlistedPublicQuery(params, new Set(['limit', 'after', 'startAt']))
    const readFeed = readPublicEventFeedService({
      feed: createPublicEventFeedRepository(),
    })
    const page = await readFeed({
      workspaceId: actor.workspaceId,
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
      ...(params.has('after') ? { after: params.get('after') ?? '' } : {}),
      ...(params.has('startAt') ? { startAt: params.get('startAt') ?? '' } : {}),
    })
    return NextResponse.json(
      presentSuccess(presentPublicEventFeed(page)),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
