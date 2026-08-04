import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createProductionBatchService,
  listProductionBatchesService,
} from '@/v2/application/production-batches'
import { DomainError } from '@/v2/domain/errors'
import {
  createProductionBatchRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  parseCreateProductionBatchBody,
  presentProductionBatchV2,
  presentProductionBatchPageV2,
} from '@/v2/public-api/production-batch-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const limitValue = request.nextUrl.searchParams.get('limit')
    const page = await listProductionBatchesService({
      repository: createProductionBatchRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId:
        request.nextUrl.searchParams.get('projectId') ?? undefined,
      status: request.nextUrl.searchParams.get('status') ?? undefined,
      query: request.nextUrl.searchParams.get('q') ?? undefined,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentProductionBatchPageV2(page)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseCreateProductionBatchBody(rawBody)
    const result = await createProductionBatchService({
      repository: createProductionBatchRepository(),
      clock: () => new Date(),
      createBatchId: () => `production-batch-${randomUUID()}`,
      createItemId: () => `production-batch-item-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      ...body,
      actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        batch: presentProductionBatchV2(result.batch),
        replayed: result.replayed,
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
