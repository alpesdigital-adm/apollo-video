import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createCaptureSessionService,
  listCaptureSessionsService,
} from '@/v2/application/capture-session'
import { DomainError } from '@/v2/domain/errors'
import { createCaptureSessionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  parseCreateCaptureSessionBody,
  presentCaptureSessionSummary,
} from '@/v2/public-api/capture-session-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'limit' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const rawLimit = params.get('limit')
    const sessions = await listCaptureSessionsService({
      repository: createCaptureSessionRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    })
    return NextResponse.json(
      presentSuccess({ sessions: sessions.map(presentCaptureSessionSummary) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseCreateCaptureSessionBody(rawBody)
    const result = await createCaptureSessionService({
      repository: createCaptureSessionRepository(),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, clientId: actor.clientId },
      projectId,
      sessionId: body.sessionId,
      clock: body.clock,
      referenceTrack: body.referenceTrack,
      lineage: body.lineage,
    })
    return NextResponse.json(
      presentSuccess({
        session: presentCaptureSessionSummary(result.session),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
