import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readDirectorQualityReportService } from '@/v2/application/read-director-quality-report'
import { createDirectorRunRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentDirectorQualityReport } from '@/v2/public-api/director-quality-report-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ projectId: string; directorRunId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, directorRunId } = await context.params
    const qualityReport = await readDirectorQualityReportService({
      repository: createDirectorRunRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      directorRunId,
    })
    return NextResponse.json(
      presentSuccess({
        qualityReport: presentDirectorQualityReport(qualityReport),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
