import { NextRequest, NextResponse } from 'next/server'

import { readTransformationQualityService } from '@/v2/application/transformation-quality'
import { createNoveltyBudgetRepository, createTransformationQualityRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentTransformationQuality } from '@/v2/public-api/transformation-quality-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    const quality = await readTransformationQualityService({
      quality: createTransformationQualityRepository(),
      novelty: createNoveltyBudgetRepository(),
    })({ workspaceId: actor.workspaceId, projectId, actor })
    return NextResponse.json(presentSuccess(presentTransformationQuality(quality)), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
