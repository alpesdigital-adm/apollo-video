import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { enqueueFaceProducerRunService } from '@/v2/application/enqueue-face-producer-run'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createFaceProducerRequestContextRepository, createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { parseFaceProducerRunRequest } from '@/v2/public-api/perception-producer-contract'
import { presentPublicOperationV2, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/** A successful operation persists sampled face candidates only; it never approves face safety. */
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    assertExternalMutationOrigin(request, actor)
    let raw: unknown
    try { raw = await request.json() }
    catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseFaceProducerRunRequest(raw)
    const { projectId } = await context.params
    const result = await enqueueFaceProducerRunService({
      context: createFaceProducerRequestContextRepository(),
      operations: createPublicOperationRepository(),
      createOperationId: () => `operation-face-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId, projectId, ...body, actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
      traceId: requestId,
    })
    return NextResponse.json(presentSuccess({
      operation: presentPublicOperationV2(result.operation, { includeProjectId: true }),
      replayed: result.replayed,
    }), { status: result.replayed ? 200 : 202, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
