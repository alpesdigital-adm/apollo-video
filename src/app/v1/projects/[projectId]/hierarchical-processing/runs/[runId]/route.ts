import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readHierarchicalProcessingRunService,
} from '@/v2/application/hierarchical-processing'
import {
  createHierarchicalProcessingRepository,
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
  presentHierarchicalProcessingRun,
} from '@/v2/public-api/hierarchical-processing-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ projectId: string; runId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, runId } = await context.params
    const run = await readHierarchicalProcessingRunService({
      repository: createHierarchicalProcessingRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      runId,
    })
    return NextResponse.json(
      presentSuccess({
        run: presentHierarchicalProcessingRun(run),
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
