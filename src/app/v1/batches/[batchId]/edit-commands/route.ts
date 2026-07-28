import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  listBatchEditCommandsService,
} from '@/v2/application/batch-edits'
import {
  createBatchEditRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentBatchEditCommandPage,
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
  context: { params: Promise<{ batchId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId } = await context.params
    const limitValue = request.nextUrl.searchParams.get('limit')
    const page = await listBatchEditCommandsService({
      repository: createBatchEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentBatchEditCommandPage(page)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
