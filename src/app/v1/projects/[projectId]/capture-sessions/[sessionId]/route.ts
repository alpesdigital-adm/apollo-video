import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readCaptureSessionService } from '@/v2/application/capture-session'
import { DomainError } from '@/v2/domain/errors'
import { createCaptureSessionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentCaptureSession } from '@/v2/public-api/capture-session-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { sessionId } = await context.params
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'version' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    // Omitting `version` reads the head. Naming one reads that exact link of
    // the chain, which is how an operator sees what a cut was actually made
    // against rather than what the session says today.
    const rawVersion = params.get('version')
    if (rawVersion !== null && !/^[1-9][0-9]{0,8}$/.test(rawVersion)) {
      throw new DomainError('INVALID_ARGUMENT', 'version must be a positive integer')
    }
    const session = await readCaptureSessionService({
      repository: createCaptureSessionRepository(),
    })({
      workspaceId: actor.workspaceId,
      sessionId,
      version: rawVersion === null ? undefined : Number(rawVersion),
    })
    return NextResponse.json(
      presentSuccess({ session: presentCaptureSession(session) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
