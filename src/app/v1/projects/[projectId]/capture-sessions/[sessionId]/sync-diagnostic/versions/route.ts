import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listSyncDiagnosticVersionsService } from '@/v2/application/sync-diagnostic'
import { DomainError } from '@/v2/domain/errors'
import { createSyncDiagnosticRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentSyncDiagnosticVersion } from '@/v2/public-api/sync-diagnostic-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
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
    const rawLimit = params.get('limit')
    const { sessionId } = await context.params
    const versions = await listSyncDiagnosticVersionsService({
      repository: createSyncDiagnosticRepository(),
    })({
      workspaceId: actor.workspaceId,
      sessionId,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    })
    return NextResponse.json(
      presentSuccess({ versions: versions.map(presentSyncDiagnosticVersion) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
