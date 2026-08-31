import { NextRequest, NextResponse } from 'next/server'

import { createSyntheticCriticReportQueryServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentSyntheticCriticReport } from '@/v2/public-api/synthetic-critic-report-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; blockId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, blockId } = await context.params
    assertAllowlistedPublicQuery(request.nextUrl.searchParams, new Set())
    const services = createSyntheticCriticReportQueryServices()
    const report = await services.readBlockEvidence({
      workspaceId: actor.workspaceId,
      projectId,
      blockId,
      actor,
    })
    return NextResponse.json(
      presentSuccess({ report: presentSyntheticCriticReport(report) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
