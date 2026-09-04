import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { detectSyncMarkerService } from '@/v2/application/sync-diagnostic'
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
import {
  parseDetectSyncMarkerBody,
  presentMarkerDetection,
} from '@/v2/public-api/sync-diagnostic-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string; markerId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    for (const name of request.nextUrl.searchParams.keys()) {
      throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
    }
    const { sessionId, markerId } = await context.params
    const detections = await createSyncDiagnosticRepository().listDetections({
      workspaceId: actor.workspaceId,
      sessionId,
    })
    return NextResponse.json(
      presentSuccess({
        detections: detections
          .filter((detection) => detection.markerId === markerId)
          .map(presentMarkerDetection),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string; markerId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { sessionId, markerId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseDetectSyncMarkerBody(rawBody)
    const resolver = createCaptureMediaResolver()
    const result = await detectSyncMarkerService({
      repository: createSyncDiagnosticRepository(),
      sessions: createCaptureSessionRepository(),
      media: createMarkerMediaPort(),
      // The path comes from the track's own ingested file, verified against
      // the hash the session recorded. Nothing in the request names a file.
      resolveMediaPath: (input) => resolver.resolve(input),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      markerId,
      trackId: body.trackId,
      mode: body.mode,
    })
    return NextResponse.json(
      presentSuccess({
        detection: presentMarkerDetection(result.detection),
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
