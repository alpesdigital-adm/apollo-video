import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listMulticamLongformGateCriteria } from '@/v2/application/multicam-longform-gate'
import { DomainError } from '@/v2/domain/errors'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentMulticamLongformGateCriteria } from '@/v2/public-api/multicam-longform-gate-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * The catalogue: what the phase gate checks, before anything has been run.
 *
 * Not under a project, because it is not about one. The ten conditions and the
 * named checks each is made of are a property of the gate, and an operator
 * asking "what does this phase demand?" needs the answer before there is a
 * project to evaluate. It reads no database at all — the application module
 * that owns the criteria is the single source both this and the evaluator use,
 * so a criterion renamed in the domain is renamed here in the same commit or
 * the build fails.
 */
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const [unsupported] = [...request.nextUrl.searchParams.keys()]
    if (unsupported !== undefined) {
      throw new DomainError('INVALID_ARGUMENT', `${unsupported} is not a supported singular filter`)
    }
    return NextResponse.json(
      presentSuccess(presentMulticamLongformGateCriteria(listMulticamLongformGateCriteria())),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
