import { NextRequest, NextResponse } from 'next/server'

import { createSyntheticCacheDecisionQueryServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseSyntheticCacheDecisionListQuery,
  presentSyntheticCacheDecision,
  SYNTHETIC_CACHE_DECISION_LIST_QUERY_PARAMETERS,
} from '@/v2/public-api/synthetic-cache-decision-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    assertAllowlistedPublicQuery(
      request.nextUrl.searchParams,
      SYNTHETIC_CACHE_DECISION_LIST_QUERY_PARAMETERS,
    )
    const query = parseSyntheticCacheDecisionListQuery(request.nextUrl.searchParams)
    const services = createSyntheticCacheDecisionQueryServices()
    const decisions = await services.list({
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      ...query,
    })
    return NextResponse.json(
      presentSuccess({ decisions: decisions.map(presentSyntheticCacheDecision) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
