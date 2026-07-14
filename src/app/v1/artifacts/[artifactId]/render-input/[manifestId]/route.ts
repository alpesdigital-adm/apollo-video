import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readMediaArtifactRenderInputService } from '@/v2/application/read-media-artifact-render-input'
import { createMediaArtifactQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string; manifestId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const { artifactId, manifestId } = await context.params
    const readRenderInput = readMediaArtifactRenderInputService({
      repository: createMediaArtifactQueryRepository(),
    })
    const renderInput = await readRenderInput(
      actor.workspaceId,
      artifactId,
      manifestId,
    )
    return NextResponse.json(presentSuccess(renderInput), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
