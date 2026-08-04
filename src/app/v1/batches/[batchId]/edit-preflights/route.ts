import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createBatchEditPreflightService,
  listBatchEditPreflightsService,
} from '@/v2/application/batch-edits'
import { DomainError } from '@/v2/domain/errors'
import {
  createBatchEditRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  createPreflightCommitTokenIssuerFromEnvironment,
} from '@/v2/infrastructure/security/preflight-commit-token'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseCreateBatchEditPreflightBody,
  presentBatchEditPreflight,
  presentBatchEditPreflightPage,
} from '@/v2/public-api/batch-edit-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ batchId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId } = await context.params
    const limitValue = request.nextUrl.searchParams.get('limit')
    const page = await listBatchEditPreflightsService({
      repository: createBatchEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentBatchEditPreflightPage(page)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ batchId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { batchId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseCreateBatchEditPreflightBody(rawBody)
    const result = await createBatchEditPreflightService({
      repository: createBatchEditRepository(),
      tokenIssuer: createPreflightCommitTokenIssuerFromEnvironment(),
      clock: () => new Date(),
      createPreflightId: () =>
        `batch-edit-preflight-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      batchId,
      ...body,
      actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        preflight: presentBatchEditPreflight(result.run),
        replayed: result.replayed,
        ...(result.commitToken
          ? { commitToken: result.commitToken }
          : {}),
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
