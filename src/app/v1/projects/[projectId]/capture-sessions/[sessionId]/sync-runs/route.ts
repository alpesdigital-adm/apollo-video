import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { requestCaptureSyncService } from '@/v2/application/capture-session'
import { DomainError } from '@/v2/domain/errors'
import {
  createCaptureSessionRepository,
  createCaptureSyncRunRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { parseRequestCaptureSyncBody } from '@/v2/public-api/capture-session-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * Start a durable synchronization of the session.
 *
 * 202, not 201: nothing is synchronized when this returns. The response names
 * the run so a caller can poll it, and requesting again supersedes whatever was
 * still queued or running — an older run settling afterwards would file a
 * result measured against a session the operator has already changed.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId, sessionId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseRequestCaptureSyncBody(rawBody)
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    if (idempotencyKey.length === 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'An idempotency key is required so a retried request rejoins its run instead of starting a second pass over the same media',
      )
    }
    const result = await requestCaptureSyncService({
      repository: createCaptureSessionRepository(),
      runs: createCaptureSyncRunRepository(),
      createId: () => `capture-sync-run-${randomUUID()}`,
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, clientId: actor.clientId },
      projectId,
      sessionId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        run: {
          sessionId: result.run.sessionId,
          operationId: result.run.id,
          state: result.run.status === 'superseded' ? 'failed' : result.run.status,
          sessionVersion: result.run.baseVersion,
        },
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 202,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
