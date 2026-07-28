import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readBatchEditPreflightService,
} from '@/v2/application/batch-edits'
import {
  createBatchEditRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentBatchEditPreflight,
} from '@/v2/public-api/batch-edit-contract'
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
    params: Promise<{ batchId: string; preflightId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, preflightId } = await context.params
    const preflight = await readBatchEditPreflightService({
      repository: createBatchEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      preflightId,
    })
    return NextResponse.json(
      presentSuccess({
        preflight: presentBatchEditPreflight(preflight),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
