import { NextRequest, NextResponse } from 'next/server'

import { applyTransformationFallbackActionService } from '@/v2/application/transformation-quality'
import { DomainError } from '@/v2/domain/errors'
import { createTransformationQualityRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseTransformationFallbackAction } from '@/v2/public-api/transformation-quality-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; ledgerId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, ledgerId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const result = await applyTransformationFallbackActionService({
      quality: createTransformationQualityRepository(),
    })({ workspaceId: actor.workspaceId, projectId, ledgerId, ...parseTransformationFallbackAction(raw), actor })
    return NextResponse.json(presentSuccess(result), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
