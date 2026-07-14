import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { preflightMediaArtifactReconstructionService } from '@/v2/application/preflight-media-artifact-reconstruction'
import { DomainError } from '@/v2/domain/errors'
import {
  createMediaArtifactQueryRepository,
  createProtectedRenderInputStore,
  createRenderInputAssetAvailability,
} from '@/v2/infrastructure/repository-factory'
import { createConfiguredRenderTargetRegistry } from '@/v2/infrastructure/render-target-registry'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string; manifestId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const contentLength = request.headers.get('content-length')
    const hasRequestBody =
      request.headers.has('transfer-encoding') ||
      (contentLength !== null &&
        (!/^\d+$/.test(contentLength) || Number(contentLength) > 0))
    if (hasRequestBody) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Reconstruction preflight does not accept a request body',
      )
    }
    const { artifactId, manifestId } = await context.params
    const preflight = preflightMediaArtifactReconstructionService({
      repository: createMediaArtifactQueryRepository(),
      protectedRenderInputs: createProtectedRenderInputStore(),
      assetAvailability: createRenderInputAssetAvailability(),
      targets: createConfiguredRenderTargetRegistry(),
    })
    const result = await preflight(actor.workspaceId, artifactId, manifestId)
    return NextResponse.json(presentSuccess(result), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
