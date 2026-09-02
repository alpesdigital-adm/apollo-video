import { NextRequest, NextResponse } from 'next/server'

import { DomainError } from '@/v2/domain/errors'
import { createSyntheticCacheDecisionQueryServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseSyntheticCacheDecisionTraceQuery,
  presentSyntheticCacheDecision,
  SYNTHETIC_CACHE_DECISION_TRACE_QUERY_PARAMETERS,
} from '@/v2/public-api/synthetic-cache-decision-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { workspaceId } = await context.params
    if (workspaceId !== actor.workspaceId) {
      throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
    }
    assertAllowlistedPublicQuery(
      request.nextUrl.searchParams,
      SYNTHETIC_CACHE_DECISION_TRACE_QUERY_PARAMETERS,
    )
    const query = parseSyntheticCacheDecisionTraceQuery(request.nextUrl.searchParams)
    const services = createSyntheticCacheDecisionQueryServices()
    const decisions = await services.trace({ workspaceId, actor, ...query })
    return NextResponse.json(
      presentSuccess({
        cacheKey: query.cacheKey,
        decisions: decisions.map(presentSyntheticCacheDecision),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
