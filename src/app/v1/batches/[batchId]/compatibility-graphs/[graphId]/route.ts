import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readCompatibilityGraphService,
} from '@/v2/application/compatibility-graphs'
import {
  createCompatibilityGraphRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentCompatibilityGraph,
} from '@/v2/public-api/compatibility-graph-contract'
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
    params: Promise<{ batchId: string; graphId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, graphId } = await context.params
    const graph = await readCompatibilityGraphService({
      repository: createCompatibilityGraphRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      runId: graphId,
    })
    return NextResponse.json(
      presentSuccess({
        graph: presentCompatibilityGraph(graph),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
