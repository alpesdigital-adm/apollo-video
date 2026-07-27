import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  reviewScriptAlignmentService,
} from '@/v2/application/script-alignments'
import { DomainError } from '@/v2/domain/errors'
import {
  createScriptAlignmentRepository,
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
  parseScriptAlignmentReviewBody,
  presentScriptAlignmentRun,
} from '@/v2/public-api/script-alignment-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; alignmentId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { batchId, alignmentId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseScriptAlignmentReviewBody(rawBody)
    const result = await reviewScriptAlignmentService({
      repository: createScriptAlignmentRepository(),
      clock: () => new Date(),
      createReviewId: () => `script-alignment-review-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      batchId,
      runId: alignmentId,
      ...body,
      actor: {
        type: 'api-client',
        id: actor.clientId,
      },
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        alignment: presentScriptAlignmentRun(result.run),
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
