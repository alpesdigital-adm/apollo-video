import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readContaminationReportService,
} from '@/v2/application/contamination-reports'
import {
  createContaminationReportRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentContaminationReport,
} from '@/v2/public-api/contamination-report-contract'
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
    params: Promise<{ projectId: string; reportId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, reportId } = await context.params
    const report = await readContaminationReportService({
      repository: createContaminationReportRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      reportId,
    })
    return NextResponse.json(
      presentSuccess({
        report: presentContaminationReport(report),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
