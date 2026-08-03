import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  actOnProductionBatchItemService,
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
  parseProductionBatchItemActionBody,
  presentProductionBatchV2,
} from '@/v2/public-api/production-batch-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; itemId: string }>
  },
) {
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
    const body = parseProductionBatchItemActionBody(rawBody)
    const { batchId, itemId } = await context.params
    const result = await actOnProductionBatchItemService({
      repository: createProductionBatchRepository(),
      clock: () => new Date(),
      createActionId: () =>
        `production-batch-action-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      batchId,
      itemId,
      ...body,
      actor: actor.auditContext.actor,
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
