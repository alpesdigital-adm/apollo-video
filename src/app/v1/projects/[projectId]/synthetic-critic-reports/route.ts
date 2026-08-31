import { NextRequest, NextResponse } from 'next/server'

import { createSyntheticCriticReportQueryServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseSyntheticCriticReportListQuery,
  presentSyntheticCriticReport,
  SYNTHETIC_CRITIC_REPORT_LIST_QUERY_PARAMETERS,
} from '@/v2/public-api/synthetic-critic-report-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    assertAllowlistedPublicQuery(
      request.nextUrl.searchParams,
      SYNTHETIC_CRITIC_REPORT_LIST_QUERY_PARAMETERS,
    )
    const query = parseSyntheticCriticReportListQuery(request.nextUrl.searchParams)
    const services = createSyntheticCriticReportQueryServices()
    const reports = await services.list({
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      ...query,
    })
    return NextResponse.json(
      presentSuccess({ reports: reports.map(presentSyntheticCriticReport) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
