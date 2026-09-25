import { NextRequest, NextResponse } from 'next/server'

import { readTransformationCriticReportService } from '@/v2/application/transformation-quality'
import { createTransformationQualityRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentTransformationCriticReport } from '@/v2/public-api/transformation-quality-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; reportId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    assertAllowlistedPublicQuery(request.nextUrl.searchParams, new Set())
    const { projectId, reportId } = await context.params
    const report = await readTransformationCriticReportService({
      quality: createTransformationQualityRepository(),
    })({ workspaceId: actor.workspaceId, projectId, reportId, actor })
    return NextResponse.json(
      presentSuccess(presentTransformationCriticReport(report)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
