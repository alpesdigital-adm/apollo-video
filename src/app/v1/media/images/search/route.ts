import { NextRequest, NextResponse } from 'next/server'

import { searchReusableImagesService } from '@/v2/application/analyze-image-artifact'
import { requireScope } from '@/v2/application/authenticate-api-client'
import type { ImageUsage } from '@/v2/domain/image-library'
import { createImageAnalysisRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const params = request.nextUrl.searchParams
    assertAllowlistedPublicQuery(params, new Set(['query', 'usage', 'limit']))
    const result = await searchReusableImagesService({ repository: createImageAnalysisRepository() })({
      workspaceId: actor.workspaceId,
      text: params.get('query') ?? '',
      usage: params.get('usage') as ImageUsage,
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
