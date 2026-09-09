import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMulticamLongformGateRuntime } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentMulticamLongformGateOutstanding } from '@/v2/public-api/multicam-longform-gate-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * What is still missing on the newest evaluation.
 *
 * The same rows as the full record, minus the nine-tenths a reader deciding
 * what to do next does not need, and ordered so the first line is the first
 * thing to do: criteria nothing has ever answered come before criteria that
 * answered and refused.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const [unsupported] = [...request.nextUrl.searchParams.keys()]
    if (unsupported !== undefined) {
      throw new DomainError('INVALID_ARGUMENT', `${unsupported} is not a supported singular filter`)
    }
    const { projectId } = await context.params
    const explained = await createMulticamLongformGateRuntime().explain({
      workspaceId: actor.workspaceId,
      projectId,
    })
    return NextResponse.json(
      presentSuccess(presentMulticamLongformGateOutstanding(explained)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
