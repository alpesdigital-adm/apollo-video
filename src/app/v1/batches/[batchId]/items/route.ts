import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  listProductionBatchItemOperationsService,
} from '@/v2/application/production-batches'
import {
  createProductionBatchRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ batchId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'operations:read')
    const { batchId } = await context.params
    const limit = request.nextUrl.searchParams.get('limit')
    const page = await listProductionBatchItemOperationsService({
      repository: createProductionBatchRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      actor,
      limit: limit === null ? undefined : Number(limit),
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(presentSuccess(page), {
      status: 200,
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
