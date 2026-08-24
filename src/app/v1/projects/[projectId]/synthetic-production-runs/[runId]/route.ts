import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readSyntheticProductionRunService } from '@/v2/application/synthetic-production'
import { createSyntheticProductionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentSyntheticProductionRun } from '@/v2/public-api/synthetic-production-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; runId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, runId } = await context.params
    const run = await readSyntheticProductionRunService({
      repository: createSyntheticProductionRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      runId,
      actor,
    })
    return NextResponse.json(
      presentSuccess({ run: presentSyntheticProductionRun(run) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
