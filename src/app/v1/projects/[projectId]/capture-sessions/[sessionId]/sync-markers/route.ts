import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { generateSyncMarkerService } from '@/v2/application/sync-diagnostic'
import { DomainError } from '@/v2/domain/errors'
import {
  createCaptureSessionRepository,
  createMarkerMediaPort,
  createSyncDiagnosticRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseGenerateSyncMarkerBody,
  presentSyncMarker,
} from '@/v2/public-api/sync-diagnostic-contract'

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
    const markers = await createSyncDiagnosticRepository().listMarkers({
      workspaceId: actor.workspaceId,
      sessionId,
    })
    return NextResponse.json(
      presentSuccess({ markers: markers.map(presentSyncMarker) }),
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
    const body = parseGenerateSyncMarkerBody(rawBody)
    // No sequence in the body. The service assigns it from what this session
    // already has, so two operators generating a marker at once cannot both
    // claim number three and leave "which marker was seen" unanswerable.
    const result = await generateSyncMarkerService({
      repository: createSyncDiagnosticRepository(),
      sessions: createCaptureSessionRepository(),
      media: createMarkerMediaPort(),
      clock: () => new Date(),
    })({
      // The whole credential, not just the workspace and client: two
      // credentials of one client are two callers, and one must not be able
      // to replay the other's key.
      actor: {
        workspaceId: actor.workspaceId,
        kind: 'api-client',
        id: actor.clientId,
        credentialId: actor.credentialId,
        authenticationKind: actor.authenticationKind,
        delegatedUserId: actor.delegatedUserId,
      },
      sessionId,
      position: body.position,
      kind: body.kind,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        marker: presentSyncMarker({ marker: result.marker, artifact: result.artifact }),
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
