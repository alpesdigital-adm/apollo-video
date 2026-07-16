import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { revokeMediaDownloadGrantService } from '@/v2/application/manage-media-download-grant'
import { createMediaDownloadGrantRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ grantId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'artifacts:read')
    const { grantId } = await context.params
    const result = await revokeMediaDownloadGrantService({ grants: createMediaDownloadGrantRepository() })({ workspaceId: actor.workspaceId, clientId: actor.clientId, grantId })
    return NextResponse.json(presentSuccess({ grant: { id: result.grant!.id, artifactId: result.grant!.artifactId, status: result.grant!.status, expiresAt: result.grant!.expiresAt, revokedAt: result.grant!.revokedAt }, replayed: result.replayed }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
