import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { solveResponsivePlacementService } from '@/v2/application/solve-responsive-placement'
import { DomainError } from '@/v2/domain/errors'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseResponsivePlacementBody } from '@/v2/public-api/responsive-placement-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    let value: unknown
    try { value = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const result = await solveResponsivePlacementService()(parseResponsivePlacementBody(value))
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
