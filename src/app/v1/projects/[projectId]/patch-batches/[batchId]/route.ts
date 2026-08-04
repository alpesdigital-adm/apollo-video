import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readReviewPatchBatchService } from '@/v2/application/review-patch-batch'
import { createReviewPatchBatchRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentReviewPatchBatch } from '@/v2/public-api/collaborative-review-presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; batchId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, batchId } = await context.params
    const batch = await readReviewPatchBatchService({ repository: createReviewPatchBatchRepository() })({
      workspaceId: actor.workspaceId,
      projectId,
      batchId,
    })
    return NextResponse.json(presentSuccess({ batch: presentReviewPatchBatch(batch) }), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
