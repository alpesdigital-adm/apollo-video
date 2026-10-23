import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { reviseProductionBatchEditorialRequestService } from '@/v2/application/batch-editorial-request'
import { readProductionBatchEditorialRequestService } from '@/v2/application/production-batches'
import { DomainError } from '@/v2/domain/errors'
import { createInterpretBrief } from '@/v2/infrastructure/brief/create-interpret-brief'
import { createProductionBatchRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseReviseProductionBatchEditorialRequestBody,
  presentProductionBatchEditorialRequest,
  presentProductionBatchEditorialRequestRevision,
} from '@/v2/public-api/production-batch-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ batchId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId } = await context.params
    const view = await readProductionBatchEditorialRequestService({ repository: createProductionBatchRepository() })({
      workspaceId: actor.workspaceId,
      batchId,
    })
    return NextResponse.json(presentSuccess(presentProductionBatchEditorialRequest(view)), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ batchId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { batchId } = await context.params
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseReviseProductionBatchEditorialRequestBody(raw)
    const result = await reviseProductionBatchEditorialRequestService({
      repository: createProductionBatchRepository(),
      interpretBrief: createInterpretBrief(),
      createRevisionId: () => `production-batch-request-revision-${randomUUID()}`,
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      body,
      actor,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(
      presentSuccess(presentProductionBatchEditorialRequestRevision(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
