import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { summarizeOperationTelemetryService } from '@/v2/application/summarize-operation-telemetry'
import { DomainError } from '@/v2/domain/errors'
import { createOperationTelemetryQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'operations:read')
    const params = request.nextUrl.searchParams
    const allowed = new Set(['from', 'to'])
    for (const name of params.keys()) {
      if (!allowed.has(name)) throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
    }
    for (const name of allowed) {
      if (params.getAll(name).length > 1) throw new DomainError('INVALID_ARGUMENT', `${name} cannot be repeated`)
    }
    const summarize = summarizeOperationTelemetryService({ telemetry: createOperationTelemetryQueryRepository() })
    const result = await summarize({
      workspaceId: actor.workspaceId,
      ...(params.has('from') ? { from: params.get('from') ?? '' } : {}),
      ...(params.has('to') ? { to: params.get('to') ?? '' } : {}),
    })
    return NextResponse.json(presentSuccess(result), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
