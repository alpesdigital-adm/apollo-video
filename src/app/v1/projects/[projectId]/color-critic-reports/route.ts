import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createColorCriticReportReadServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { identifier, integerParameter } from '@/v2/public-api/capture-derivation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentColorCriticReportListing } from '@/v2/public-api/multicam-color-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const FILTERS = ['projectVersionId', 'limit']

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
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
    const { projectId } = await context.params
    const limit = integerParameter(params.get('limit'), 'limit', 1, 100)
    const result = await createColorCriticReportReadServices().list({
      workspaceId: actor.workspaceId,
      projectId,
      // A verdict is about one exact version of a cut. The registry already
      // refuses the request without it; this is what reads it.
      projectVersionId: identifier(params.get('projectVersionId'), 'projectVersionId'),
      ...(limit === undefined ? {} : { limit }),
    })
    return NextResponse.json(
      presentSuccess(presentColorCriticReportListing(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
