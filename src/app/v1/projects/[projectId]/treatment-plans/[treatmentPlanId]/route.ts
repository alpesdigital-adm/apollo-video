import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readTreatmentPlanService } from '@/v2/application/treatment-plans'
import { createTreatmentPlanRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentTreatmentPlan } from '@/v2/public-api/treatment-plan-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; treatmentPlanId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, treatmentPlanId } = await context.params
    const value = await readTreatmentPlanService({ repository: createTreatmentPlanRepository() })({ workspaceId: actor.workspaceId, projectId, treatmentPlanId })
    return NextResponse.json(presentSuccess({ treatmentPlan: presentTreatmentPlan(value) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
