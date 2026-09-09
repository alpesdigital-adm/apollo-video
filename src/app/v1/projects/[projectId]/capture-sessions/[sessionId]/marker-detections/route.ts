import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { runMarkerDetectionSweep } from '@/v2/application/run-marker-detection-sweep'
import { DomainError } from '@/v2/domain/errors'
import {
  createCaptureMediaResolver,
  createCaptureSessionRepository,
  createMarkerMediaPort,
  createSyncDiagnosticRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentMarkerDetectionSweep } from '@/v2/public-api/sync-diagnostic-contract'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { sessionId } = await context.params
    for (const name of request.nextUrl.searchParams.keys()) {
      throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
    }
    const resolver = createCaptureMediaResolver()
    // Bounded on purpose. Each pair is an FFmpeg decode of a real recording,
    // and a long session should make progress on every pass rather than time
    // out on the same first attempt forever. `complete: false` in the response
    // is the caller's instruction to call again.
    const result = await runMarkerDetectionSweep({
      repository: createSyncDiagnosticRepository(),
      sessions: createCaptureSessionRepository(),
      media: createMarkerMediaPort(),
      resolveMediaPath: (input) => resolver.resolve(input),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
    })
    return NextResponse.json(
      presentSuccess({ sweep: presentMarkerDetectionSweep(result) }),
      {
        // 200 when there is nothing left to do, 202 while pairs remain: the
        // status says whether calling again would find more work.
        status: result.complete ? 200 : 202,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
