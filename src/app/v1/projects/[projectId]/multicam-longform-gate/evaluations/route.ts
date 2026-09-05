import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMulticamLongformGateRuntime } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { integerParameter } from '@/v2/public-api/capture-derivation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseEvaluateMulticamLongformGateBody,
  presentMulticamLongformGateEvaluated,
  presentMulticamLongformGateHistory,
} from '@/v2/public-api/multicam-longform-gate-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'limit' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const limit = integerParameter(params.get('limit'), 'limit', 1, 100)
    const { projectId } = await context.params
    const gates = await createMulticamLongformGateRuntime().list({
      workspaceId: actor.workspaceId,
      projectId,
      ...(limit === undefined ? {} : { limit }),
    })
    return NextResponse.json(
      presentSuccess(presentMulticamLongformGateHistory(gates)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    // The whole body: an optional session filter. Every criterion result, every
    // hash and the approval itself are read from PostgreSQL and the module
    // graph by the evaluation, so there is nothing here a caller could use to
    // assert an outcome — and a key that tried is refused by name.
    const body = parseEvaluateMulticamLongformGateBody(rawBody)
    // Read here and threaded into the service, which binds it to the whole
    // actor: workspace, client, credential, authentication kind and any
    // delegated user. Two clicks on "run the gate" return one record; the same
    // key with a different session filter is refused as a payload mismatch
    // rather than quietly answering about a different session.
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    const result = await createMulticamLongformGateRuntime().evaluate({
      workspaceId: actor.workspaceId,
      projectId,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      actor,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess(presentMulticamLongformGateEvaluated(result)),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
