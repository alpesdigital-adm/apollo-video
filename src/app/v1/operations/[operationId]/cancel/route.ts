import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { cancelPublicOperationService } from '@/v2/application/cancel-public-operation'
import { createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ operationId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'operations:cancel')
    const { operationId } = await context.params
    const cancel = cancelPublicOperationService({
      operations: createPublicOperationRepository(),
    })
    const operation = await cancel({ workspaceId: actor.workspaceId, operationId })
    return NextResponse.json(
      presentSuccess({ operation: presentPublicOperation(operation) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
