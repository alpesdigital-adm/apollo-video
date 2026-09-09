import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  attachCaptureProtocolService,
  readCaptureSessionProtocolService,
} from '@/v2/application/capture-protocol'
import { DomainError } from '@/v2/domain/errors'
import {
  createCaptureProtocolRepository,
  createCaptureSessionRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  parseAttachCaptureProtocolBody,
  presentCaptureSessionProtocol,
} from '@/v2/public-api/capture-protocol-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
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
    for (const name of request.nextUrl.searchParams.keys()) {
      throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
    }
    const { sessionId } = await context.params
    const result = await readCaptureSessionProtocolService({
      repository: createCaptureProtocolRepository(),
      sessions: createCaptureSessionRepository(),
    })({ workspaceId: actor.workspaceId, sessionId })
    return NextResponse.json(
      presentSuccess(presentCaptureSessionProtocol(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { sessionId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseAttachCaptureProtocolBody(rawBody)
    const attachment = await attachCaptureProtocolService({
      repository: createCaptureProtocolRepository(),
      sessions: createCaptureSessionRepository(),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      protocolId: body.protocolId,
    })
    return NextResponse.json(
      presentSuccess({
        attachment: {
          protocolId: attachment.protocolId,
          protocolVersion: attachment.protocolVersion,
          protocolHash: attachment.protocolHash,
          attachedAt: attachment.attachedAt,
        },
      }),
      { status: 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
