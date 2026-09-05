import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createColorCriticReportReadServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseIssueDimension,
  parseIssueSeverity,
  presentColorCriticIssueListing,
} from '@/v2/public-api/multicam-color-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const FILTERS = ['severity', 'dimension']

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ reportId: string }> },
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
    const { reportId } = await context.params
    const severity = parseIssueSeverity(params.get('severity'))
    const dimension = parseIssueDimension(params.get('dimension'))
    const result = await createColorCriticReportReadServices().listIssues({
      workspaceId: actor.workspaceId,
      reportId,
      ...(severity === undefined ? {} : { severity }),
      ...(dimension === undefined ? {} : { dimension }),
    })
    return NextResponse.json(
      presentSuccess(presentColorCriticIssueListing(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
