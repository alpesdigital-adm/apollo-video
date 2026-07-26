import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readProjectFinalExportAttemptsService } from '@/v2/application/read-project-final-export-attempts'
import { createProjectFinalExportRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ operationId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'operations:read')
    const { operationId } = await context.params
    const history = await readProjectFinalExportAttemptsService({
      projects: createProjectFinalExportRepository(),
    })({ workspaceId: actor.workspaceId, operationId })
    return NextResponse.json(
      presentSuccess(history),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
