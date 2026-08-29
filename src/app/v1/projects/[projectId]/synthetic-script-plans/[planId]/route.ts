import { NextRequest, NextResponse } from 'next/server'

import { createSyntheticScriptPlanServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  presentBlockGenerations,
  presentSyntheticScriptPlan,
} from '@/v2/public-api/synthetic-script-plan-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; planId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, planId } = await context.params
    const services = createSyntheticScriptPlanServices()
    // Reading settles pending generations from their durable provider jobs
    // first, so the response always reflects the persisted outcome.
    await services.settle({ workspaceId: actor.workspaceId, projectId, planId, actor })
    const plan = await services.readPlan({ workspaceId: actor.workspaceId, projectId, planId, actor })
    const generations = await services.generations.listByPlan({ workspaceId: actor.workspaceId, planId })
    return NextResponse.json(
      presentSuccess({ plan: presentSyntheticScriptPlan(plan), generations: presentBlockGenerations(generations) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
