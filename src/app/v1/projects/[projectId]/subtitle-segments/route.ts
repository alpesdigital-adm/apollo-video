import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readSubtitleSegmentsService } from '@/v2/application/subtitle-segment-overrides'
import { createSubtitleSegmentOverrideRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * The subtitle segments of ONE output of the current Version: compiled text and half-open frame range, the head exception (if any) and
 * the values a render draws. It reads; every change goes through `subtitle-segment-overrides`.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const variantId = request.nextUrl.searchParams.get('variantId') ?? ''
    const result = await readSubtitleSegmentsService({ repository: createSubtitleSegmentOverrideRepository() })({
      workspaceId: actor.workspaceId, projectId, variantId,
    })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
