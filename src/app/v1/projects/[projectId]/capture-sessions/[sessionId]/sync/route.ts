import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readCaptureSyncService } from '@/v2/application/capture-session'
import { createCaptureSessionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentSyncTrack } from '@/v2/public-api/capture-session-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * What the cascade decided for every track of the session.
 *
 * Derivations measured against an older session version are omitted rather than
 * shown with a caveat: a map computed against version 3 is not a slightly stale
 * answer for version 4, because the tracks it measured may not be the tracks in
 * the session any more.
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
    const result = await readCaptureSyncService({
      repository: createCaptureSessionRepository(),
    })({ workspaceId: actor.workspaceId, sessionId })
    return NextResponse.json(
      presentSuccess({
        sessionId: result.session.sessionId,
        sessionVersion: result.session.version,
        referenceEpoch: result.session.referenceEpoch,
        referenceTrackId: result.session.referenceTrackId,
        tracks: result.tracks.map(presentSyncTrack),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
