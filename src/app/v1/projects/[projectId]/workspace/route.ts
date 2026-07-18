import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readProjectWorkspaceService } from '@/v2/application/read-project-workspace'
import {
  createProjectWorkspaceQueryRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const workspace = await readProjectWorkspaceService({
      projects: createProjectWorkspaceQueryRepository(),
      operations: createPublicOperationRepository(),
    })({ workspaceId: actor.workspaceId, projectId })
    return NextResponse.json(
      presentSuccess({
        ...workspace,
        operations: workspace.operations.map(presentPublicOperation),
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
