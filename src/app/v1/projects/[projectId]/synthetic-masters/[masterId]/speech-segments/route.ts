import { NextRequest, NextResponse } from 'next/server'

import { createSyntheticMasterAssetServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentSyntheticSpeechSegment } from '@/v2/public-api/synthetic-master-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; masterId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, masterId } = await context.params
    const services = createSyntheticMasterAssetServices()
    const segments = await services.listSpeechSegments({
      workspaceId: actor.workspaceId,
      projectId,
      masterId,
      actor,
    })
    return NextResponse.json(
      presentSuccess({ segments: segments.map(presentSyntheticSpeechSegment) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
