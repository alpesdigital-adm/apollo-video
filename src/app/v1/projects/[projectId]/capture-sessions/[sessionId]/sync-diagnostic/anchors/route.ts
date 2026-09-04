import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { editSyncAnchorService } from '@/v2/application/sync-diagnostic'
import { DomainError } from '@/v2/domain/errors'
import { canAutoEdit } from '@/v2/domain/sync-diagnostic'
import { createSyncDiagnosticRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseAnchorEditBody,
  presentSyncDiagnostic,
} from '@/v2/public-api/sync-diagnostic-contract'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { sessionId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseAnchorEditBody(rawBody)
    // The fence lives in the append predicate, not in a read before it. A
    // check-then-write would leave a window where a second operator's nudge
    // lands between the two and is overwritten with nothing said about it.
    const result = await editSyncAnchorService({
      repository: createSyncDiagnosticRepository(),
      clock: () => new Date(),
    })({
      actor: { workspaceId: actor.workspaceId, kind: 'api-client', id: actor.clientId },
      sessionId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      edit: body.edit,
    })
    return NextResponse.json(
      presentSuccess({
        diagnostic: presentSyncDiagnostic({
          diagnostic: result.diagnostic,
          autoEdit: canAutoEdit(result.diagnostic),
        }),
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
