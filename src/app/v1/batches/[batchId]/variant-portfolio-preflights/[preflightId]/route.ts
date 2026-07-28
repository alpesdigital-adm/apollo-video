import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readVariantPortfolioPreflightService,
} from '@/v2/application/variant-portfolio-preflights'
import {
  createVariantPortfolioPreflightRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentVariantPortfolioPreflight,
} from '@/v2/public-api/variant-portfolio-preflight-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; preflightId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, preflightId } = await context.params
    const preflight = await readVariantPortfolioPreflightService({
      repository: createVariantPortfolioPreflightRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      runId: preflightId,
    })
    return NextResponse.json(
      presentSuccess({
        preflight: presentVariantPortfolioPreflight(preflight),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
