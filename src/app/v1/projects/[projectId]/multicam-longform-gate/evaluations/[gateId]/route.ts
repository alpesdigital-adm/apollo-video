import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMulticamLongformGateRuntime } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentMulticamLongformGateRead } from '@/v2/public-api/multicam-longform-gate-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * One evaluation by id, re-derived and hash-verified by the repository on read.
 *
 * A record whose stored fingerprint no longer recomputes from its own criteria
 * is refused here instead of being handed to a screen that would display an
 * approval nobody evaluated.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; gateId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const [unsupported] = [...request.nextUrl.searchParams.keys()]
    if (unsupported !== undefined) {
      throw new DomainError('INVALID_ARGUMENT', `${unsupported} is not a supported singular filter`)
    }
    const { projectId, gateId } = await context.params
    const gate = await createMulticamLongformGateRuntime().read({
      workspaceId: actor.workspaceId,
      projectId,
      gateId,
    })
    return NextResponse.json(
      presentSuccess(presentMulticamLongformGateRead(gate)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
