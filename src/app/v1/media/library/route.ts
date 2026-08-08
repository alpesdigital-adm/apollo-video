import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listMediaLibraryService } from '@/v2/application/media-library'
import type { LibraryKind, LibraryRightsStatus } from '@/v2/domain/media-library'
import { createMediaLibraryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const params = request.nextUrl.searchParams
    assertAllowlistedPublicQuery(params, new Set(['limit', 'after', 'kind', 'person', 'topic', 'rightsStatus']))
    const page = await listMediaLibraryService({ repository: createMediaLibraryRepository() })({
      workspaceId: actor.workspaceId,
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
      ...(params.has('after') ? { after: params.get('after') ?? '' } : {}),
      ...(params.has('kind') ? { kind: params.get('kind') as LibraryKind } : {}),
      ...(params.has('person') ? { person: params.get('person') ?? '' } : {}),
      ...(params.has('topic') ? { topic: params.get('topic') ?? '' } : {}),
      ...(params.has('rightsStatus') ? { rightsStatus: params.get('rightsStatus') as LibraryRightsStatus } : {}),
    })
    return NextResponse.json(presentSuccess(page), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
