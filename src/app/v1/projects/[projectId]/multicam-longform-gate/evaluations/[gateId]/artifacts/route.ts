import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMulticamLongformGateRuntime } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { integerParameter } from '@/v2/public-api/capture-derivation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  presentMulticamLongformGateArtifacts,
  resourceTypeParameter,
} from '@/v2/public-api/multicam-longform-gate-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const FILTERS = ['type', 'limit']

/**
 * The artifacts one evaluation read, so a reader can open them.
 *
 * Read out of the stored record rather than re-queried: these are the rows that
 * evaluation actually cited, with the hash state it observed at the time. A
 * fresh query would answer about today's database and quietly turn a historical
 * record into a live one.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; gateId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (!FILTERS.includes(name) || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const type = resourceTypeParameter(params.get('type'), 'type')
    const limit = integerParameter(params.get('limit'), 'limit', 1, 200)
    const { projectId, gateId } = await context.params
    const gate = await createMulticamLongformGateRuntime().read({
      workspaceId: actor.workspaceId,
      projectId,
      gateId,
    })
    return NextResponse.json(
      presentSuccess(presentMulticamLongformGateArtifacts(gate, {
        ...(type === undefined ? {} : { type }),
        limit: limit ?? 100,
      })),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
