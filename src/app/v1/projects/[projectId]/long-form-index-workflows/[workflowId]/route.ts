import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readLongFormIndexWorkflowService,
} from '@/v2/application/long-form-index-workflow'
import {
  createLongFormIndexWorkflowRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentLongFormIndexWorkflow,
} from '@/v2/public-api/long-form-index-workflow-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      projectId: string
      workflowId: string
    }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, workflowId } = await context.params
    const record = await readLongFormIndexWorkflowService({
      repository: createLongFormIndexWorkflowRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      workflowId,
    })
    return NextResponse.json(
      presentSuccess(presentLongFormIndexWorkflow(record)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
