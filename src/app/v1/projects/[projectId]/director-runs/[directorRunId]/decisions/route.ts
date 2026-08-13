import { NextRequest, NextResponse } from 'next/server'
import { listDirectorDecisionsService } from '@/v2/application/read-director-decisions'
import { createDirectorDecisionLogRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; directorRunId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, directorRunId } = await context.params
    const result = await listDirectorDecisionsService({ repository: createDirectorDecisionLogRepository() })({ workspaceId: actor.workspaceId, projectId, directorRunId, actor })
    return NextResponse.json(presentSuccess({ decisionLog: result }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
