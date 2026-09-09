import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { evaluateCaptureProtocolService } from '@/v2/application/capture-protocol'
import { observeMarkerFactsService } from '@/v2/application/sync-diagnostic'
import { DomainError } from '@/v2/domain/errors'
import {
  createCaptureProtocolRepository,
  createCaptureSessionRepository,
  createSyncDiagnosticRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  parseEvaluateCaptureProtocolBody,
  presentCaptureProtocolEvaluation,
} from '@/v2/public-api/capture-protocol-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

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
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseEvaluateCaptureProtocolBody(rawBody)
    // The marker facts are read from stored detections here, not taken from
    // the request: a caller able to assert "the marker was seen" could talk
    // the ceiling up to automatic on a session where nothing was detected.
    const result = await evaluateCaptureProtocolService({
      repository: createCaptureProtocolRepository(),
      sessions: createCaptureSessionRepository(),
      observeMarkers: observeMarkerFactsService({
        repository: createSyncDiagnosticRepository(),
      }),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      protocolId: body.protocolId,
      scenario: body.scenario,
      attestedRequirementIds: body.attestedRequirementIds,
    })
    return NextResponse.json(
      presentSuccess({
        evaluation: presentCaptureProtocolEvaluation(result.evaluation),
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
