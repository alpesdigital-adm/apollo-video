import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createTreatmentPlanService } from '@/v2/application/treatment-plans'
import { DomainError } from '@/v2/domain/errors'
import { createTreatmentPlanRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseCreateTreatmentPlanBody, presentTreatmentPlan } from '@/v2/public-api/treatment-plan-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseCreateTreatmentPlanBody(raw)
    const result = await createTreatmentPlanService({ repository: createTreatmentPlanRepository(), createId: () => `treatment-plan-${randomUUID()}` })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(presentSuccess({ treatmentPlan: presentTreatmentPlan(result.value), replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
