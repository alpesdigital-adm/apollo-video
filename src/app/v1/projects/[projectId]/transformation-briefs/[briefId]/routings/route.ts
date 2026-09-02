import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { routeTransformationBriefService } from '@/v2/application/transformation-provider-registry'
import { DomainError } from '@/v2/domain/errors'
import { createTransformationProviderRegistryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseRouteTransformationBriefBody, presentTransformationSelection } from '@/v2/public-api/transformation-brief-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; briefId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId, briefId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const policy = parseRouteTransformationBriefBody(raw)
    // Routing is a decision, and every decision is recorded — including the
    // providers that were discarded and why. Choosing a provider without a
    // written reason is how a routing change becomes unexplainable later.
    const result = await routeTransformationBriefService({
      repository: createTransformationProviderRegistryRepository(),
      workspaceId: actor.workspaceId,
      projectId, briefId, policy,
      createdAt: new Date().toISOString(),
    })
    return NextResponse.json(
      presentSuccess({ selection: presentTransformationSelection(result.selection), replayed: result.replayed }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
