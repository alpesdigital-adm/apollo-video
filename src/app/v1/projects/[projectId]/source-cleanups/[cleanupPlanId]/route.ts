import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readSourceCleanupService,
} from '@/v2/application/source-cleanups'
import {
  createSourceCleanupRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentSourceCleanup,
} from '@/v2/public-api/source-cleanup-contract'
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
    params: Promise<{
      projectId: string
      cleanupPlanId: string
    }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, cleanupPlanId } = await context.params
    const cleanup = await readSourceCleanupService({
      repository: createSourceCleanupRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      cleanupPlanId,
    })
    return NextResponse.json(
      presentSuccess({
        cleanup: presentSourceCleanup(cleanup),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
