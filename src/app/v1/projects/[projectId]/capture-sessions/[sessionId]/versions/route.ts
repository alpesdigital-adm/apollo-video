import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listCaptureSessionVersionsService } from '@/v2/application/capture-session'
import { DomainError } from '@/v2/domain/errors'
import { createCaptureSessionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentCaptureSessionVersion } from '@/v2/public-api/capture-session-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * The immutable chain, newest first.
 *
 * Each entry carries the hash of the version it replaced, so a caller can walk
 * the chain back and see that it is unbroken — a gap is detectable rather than
 * merely improbable.
 */
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
      if (name !== 'limit' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const rawLimit = params.get('limit')
    const versions = await listCaptureSessionVersionsService({
      repository: createCaptureSessionRepository(),
    })({
      workspaceId: actor.workspaceId,
      sessionId,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    })
    return NextResponse.json(
      presentSuccess({
        sessionId,
        versions: versions.map(presentCaptureSessionVersion),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
