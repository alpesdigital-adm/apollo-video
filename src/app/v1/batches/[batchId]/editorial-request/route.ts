import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readProductionBatchEditorialRequestService } from '@/v2/application/production-batches'
import { createProductionBatchRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentProductionBatchEditorialRequest } from '@/v2/public-api/production-batch-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ batchId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId } = await context.params
    const view = await readProductionBatchEditorialRequestService({ repository: createProductionBatchRepository() })({
      workspaceId: actor.workspaceId,
      batchId,
    })
    return NextResponse.json(presentSuccess(presentProductionBatchEditorialRequest(view)), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
