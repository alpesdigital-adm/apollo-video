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
 * The newest evaluation, at the gate's own address.
 *
 * A project that has never been evaluated answers
 * `MULTICAM_LONGFORM_GATE_NOT_FOUND` rather than an empty approval. "Nobody has
 * run it" and "it ran and refused" are different facts, and a 200 with
 * `approved: false` for the first would say the gate had an opinion it never
 * formed.
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
    const gate = await createMulticamLongformGateRuntime().readLatest({
      workspaceId: actor.workspaceId,
      projectId,
    })
    return NextResponse.json(
      presentSuccess(presentMulticamLongformGateRead(gate)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
