import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { issueMediaDownloadGrantService } from '@/v2/application/manage-media-download-grant'
import { DomainError } from '@/v2/domain/errors'
import { createMediaArtifactQueryRepository, createMediaDownloadGrantRepository, createMediaDownloadGrantSignerFromEnvironment } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'artifacts:read')
    const { artifactId } = await context.params
    let body: Record<string, unknown> = {}
    if (request.headers.get('content-length') !== '0') {
      try { body = await request.json() as Record<string, unknown> } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    }
    const result = await issueMediaDownloadGrantService({ artifacts: createMediaArtifactQueryRepository(), grants: createMediaDownloadGrantRepository(), signer: createMediaDownloadGrantSignerFromEnvironment() })({
      workspaceId: actor.workspaceId, clientId: actor.clientId, artifactId, idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '', ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: Number(body.ttlSeconds) }),
    })
    return NextResponse.json(presentSuccess(result), { status: 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
