import { NextRequest, NextResponse } from 'next/server'

import { createSyntheticCacheDecisionQueryServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentSyntheticCacheDecisionSummary } from '@/v2/public-api/synthetic-cache-decision-contract'

export const dynamic = 'force-dynamic'

const NO_QUERY_PARAMETERS: ReadonlySet<string> = new Set<string>()

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    assertAllowlistedPublicQuery(request.nextUrl.searchParams, NO_QUERY_PARAMETERS)
    const services = createSyntheticCacheDecisionQueryServices()
    const summary = await services.summarize({
      workspaceId: actor.workspaceId,
      projectId,
      actor,
    })
    return NextResponse.json(
      presentSuccess({ summary: presentSyntheticCacheDecisionSummary(summary) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
