import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readPublicOperationService } from '@/v2/application/read-public-operation'
import {
  createProductionBatchRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentPublicOperationV2, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ operationId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'operations:read')
    const { operationId } = await context.params
    const read = readPublicOperationService({
      operations: createPublicOperationRepository(),
      productionBatches: createProductionBatchRepository(),
    })
    const operation = await read({ workspaceId: actor.workspaceId, operationId })
    return NextResponse.json(
      presentSuccess({ operation: presentPublicOperationV2(operation, { includeProjectId: true }) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
