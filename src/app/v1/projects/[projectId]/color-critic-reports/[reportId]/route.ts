import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createColorCriticReportReadServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentColorCriticReportResponse } from '@/v2/public-api/multicam-color-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; reportId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    for (const name of request.nextUrl.searchParams.keys()) {
      throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
    }
    // Both segments are read and both are enforced. A path that names a
    // project and then answers with another project's verdict is a 404 that did
    // not happen: the client trusts the URL and files the judgement under the
    // wrong cut.
    const { projectId, reportId } = await context.params
    const report = await createColorCriticReportReadServices().read({
      workspaceId: actor.workspaceId,
      projectId,
      reportId,
    })
    return NextResponse.json(
      presentSuccess(presentColorCriticReportResponse(report)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
