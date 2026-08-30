import { NextRequest, NextResponse } from 'next/server'

import { readSyntheticPresenterProfileService } from '@/v2/application/synthetic-presenter-lifecycle'
import { createSyntheticProductionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentPresenterDetail } from '@/v2/public-api/synthetic-presenter-lifecycle-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string; presenterId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { workspaceId, presenterId } = await context.params
    const detail = await readSyntheticPresenterProfileService({
      repository: createSyntheticProductionRepository(),
    })({ workspaceId, profileId: presenterId, actor })
    return NextResponse.json(
      presentSuccess(presentPresenterDetail(detail)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
