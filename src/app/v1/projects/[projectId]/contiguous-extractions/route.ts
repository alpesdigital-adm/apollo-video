import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createContiguousExtractionService,
} from '@/v2/application/contiguous-extraction'
import { DomainError } from '@/v2/domain/errors'
import {
  createContiguousExtractionRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseCreateContiguousExtractionBody,
  presentContiguousExtraction,
} from '@/v2/public-api/contiguous-extraction-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

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
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseCreateContiguousExtractionBody(rawBody)
    const result = await createContiguousExtractionService({
      repository: createContiguousExtractionRepository(),
      createId: () => `contiguous-extraction-${randomUUID()}`,
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        extraction: presentContiguousExtraction(
          result.extraction,
        ),
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
