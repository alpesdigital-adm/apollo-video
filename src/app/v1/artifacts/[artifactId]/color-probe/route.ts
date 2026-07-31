import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readMediaColorProbeService,
} from '@/v2/application/read-media-color-probe'
import {
  createMediaArtifactQueryRepository,
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
  presentMediaColorProbe,
  presentSuccess,
} from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const { artifactId } = await context.params
    const probe = await readMediaColorProbeService({
      repository: createMediaArtifactQueryRepository(),
    })(actor.workspaceId, artifactId)
    return NextResponse.json(
      presentSuccess(presentMediaColorProbe(probe)),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
