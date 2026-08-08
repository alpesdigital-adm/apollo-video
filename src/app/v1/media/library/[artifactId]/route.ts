import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readMediaLibraryItemService } from '@/v2/application/media-library'
import { createMediaLibraryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const { artifactId } = await context.params
    const item = await readMediaLibraryItemService({ repository: createMediaLibraryRepository() })(actor.workspaceId, artifactId)
    return NextResponse.json(presentSuccess(item), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
