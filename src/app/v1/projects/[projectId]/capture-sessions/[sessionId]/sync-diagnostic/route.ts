import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  generateSyncDiagnosticService,
  readSyncDiagnosticService,
} from '@/v2/application/sync-diagnostic'
import { DomainError } from '@/v2/domain/errors'
import { canAutoEdit } from '@/v2/domain/sync-diagnostic'
import {
  createCaptureProtocolRepository,
  createCaptureSessionRepository,
  createSyncDiagnosticRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseBaseVersionBody } from '@/v2/public-api/capture-protocol-contract'
import { presentSyncDiagnostic } from '@/v2/public-api/sync-diagnostic-contract'

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
    const result = await readSyncDiagnosticService({
      repository: createSyncDiagnosticRepository(),
    })({
      workspaceId: actor.workspaceId,
      sessionId,
      version: rawVersion === null ? undefined : Number(rawVersion),
    })
    return NextResponse.json(
      presentSuccess({ diagnostic: presentSyncDiagnostic(result) }),
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
    // The only thing the body may carry is which session version this
    // diagnostic is about. Everything it is made of — detections, coverage,
    // maps, the attached protocol — already exists on the server, and a
    // request that could contribute to those could contribute a lie.
    const base = parseBaseVersionBody(rawBody)
    const result = await generateSyncDiagnosticService({
      repository: createSyncDiagnosticRepository(),
      sessions: createCaptureSessionRepository(),
      protocols: createCaptureProtocolRepository(),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      baseVersionId: base.baseVersionId,
      baseHash: base.baseHash,
    })
    return NextResponse.json(
      presentSuccess({
        diagnostic: presentSyncDiagnostic({
          diagnostic: result.diagnostic,
          autoEdit: canAutoEdit(result.diagnostic),
        }),
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
