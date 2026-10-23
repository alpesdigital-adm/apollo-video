import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readEditorialRequestService, reviseEditorialRequestService } from '@/v2/application/revise-editorial-request'
import { createInterpretBrief } from '@/v2/infrastructure/brief/create-interpret-brief'
import { createEditorialRequestRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { DomainError } from '@/v2/domain/errors'
import {
  parseReviseEditorialRequestBody,
  presentCurrentEditorialRequest,
  presentEditorialRequestRevisionResult,
} from '@/v2/public-api/editorial-request-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const value = await readEditorialRequestService({ repository: createEditorialRequestRepository() })({
      workspaceId: actor.workspaceId,
      projectId,
    })
    return NextResponse.json(presentSuccess(presentCurrentEditorialRequest(value)), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const parsed = parseReviseEditorialRequestBody(raw)
    const result = await reviseEditorialRequestService({
      repository: createEditorialRequestRepository(),
      interpretBrief: createInterpretBrief(),
      createId: (kind) => `editorial-request-${kind}-${randomUUID()}`,
      createEventId: () => randomUUID(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      baseVersionId: parsed.baseVersionId,
      baseHash: parsed.baseHash,
      body: parsed.body,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      actor,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(
      presentSuccess(presentEditorialRequestRevisionResult(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
