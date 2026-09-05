import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import {
  createDirectMulticamSessionService,
  createMulticamDirectionReadServices,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseDirectMulticamSessionBody,
  presentDirectedSession,
  presentMulticamDirectionRead,
} from '@/v2/public-api/multicam-direction-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'version' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const rawVersion = params.get('version')
    const { sessionId } = await context.params
    const result = await createMulticamDirectionReadServices().read({
      workspaceId: actor.workspaceId,
      sessionId,
      ...(rawVersion === null ? {} : { version: Number(rawVersion) }),
    })
    return NextResponse.json(
      presentSuccess(presentMulticamDirectionRead(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId, sessionId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    // The body carries the aspect ratio, the stretch of session time, the five
    // editorial numbers an operator may move, and the project version it was
    // computed against. Everything the direction is made of — coverage, clock
    // maps, the diagnostic, the evidence — is already on the server, and a
    // request that could contribute to those could contribute a lie.
    const body = parseDirectMulticamSessionBody(rawBody)
    // Read here and used by the service, which binds it to the whole actor:
    // workspace, client, credential, authentication kind and any delegated
    // user. A key reused with a different request is refused by name rather
    // than quietly producing a second cut.
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    const result = await createDirectMulticamSessionService()({
      workspaceId: actor.workspaceId,
      projectId,
      sessionId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      format: body.format,
      ...(body.range ? { range: body.range } : {}),
      ...(body.policy ? { policy: body.policy } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
      idempotency: { clientId: actor.clientId, key: idempotencyKey },
    })
    return NextResponse.json(
      presentSuccess({ directed: presentDirectedSession(result), replayed: result.replayed }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
