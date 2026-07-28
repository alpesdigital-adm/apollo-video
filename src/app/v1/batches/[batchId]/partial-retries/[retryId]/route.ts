import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readBatchPartialRetryService,
} from '@/v2/application/batch-partial-retries'
import {
  createProductionBatchRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentBatchPartialRetry,
} from '@/v2/public-api/batch-partial-retry-contract'
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
    params: Promise<{ batchId: string; retryId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, retryId } = await context.params
    const partialRetry = await readBatchPartialRetryService({
      repository: createProductionBatchRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      retryId,
    })
    return NextResponse.json(
      presentSuccess({
        partialRetry: presentBatchPartialRetry(partialRetry),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
