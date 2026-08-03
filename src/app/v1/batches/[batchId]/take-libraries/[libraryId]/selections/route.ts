import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { selectTakeService } from '@/v2/application/take-libraries'
import { DomainError } from '@/v2/domain/errors'
import {
  createTakeLibraryRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseTakeSelectionBody,
  presentTakeLibraryRun,
} from '@/v2/public-api/take-library-contract'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; libraryId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { batchId, libraryId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseTakeSelectionBody(rawBody)
    const result = await selectTakeService({
      repository: createTakeLibraryRepository(),
      clock: () => new Date(),
      createSelectionId: () => `take-selection-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      batchId,
      runId: libraryId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        library: presentTakeLibraryRun(result.run),
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
