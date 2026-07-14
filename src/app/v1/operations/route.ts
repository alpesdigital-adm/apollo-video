import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listPublicOperationsService } from '@/v2/application/list-public-operations'
import { DomainError } from '@/v2/domain/errors'
import { createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'operations:read')
    const params = request.nextUrl.searchParams
    const allowedParameters = new Set(['limit', 'after', 'status', 'type', 'targetId'])
    for (const name of params.keys()) {
      if (!allowedParameters.has(name)) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
      }
    }
    for (const name of allowedParameters) {
      if (params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} cannot be repeated`)
      }
    }
    const rawLimit = params.get('limit')
    const list = listPublicOperationsService({
      operations: createPublicOperationRepository(),
    })
    const result = await list({
      workspaceId: actor.workspaceId,
      ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
      ...(params.has('after') ? { after: params.get('after') ?? '' } : {}),
      ...(params.has('status') ? { status: params.get('status') ?? '' } : {}),
      ...(params.has('type') ? { type: params.get('type') ?? '' } : {}),
      ...(params.has('targetId') ? { targetId: params.get('targetId') ?? '' } : {}),
    })
    return NextResponse.json(
      presentSuccess({
        operations: result.operations.map(presentPublicOperation),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
