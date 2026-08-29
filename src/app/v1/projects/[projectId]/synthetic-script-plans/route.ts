import { NextRequest, NextResponse } from 'next/server'

import { DomainError } from '@/v2/domain/errors'
import { createSyntheticScriptPlanServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseCreateSyntheticScriptPlanBody,
  presentBlockGenerationOutcomes,
  presentSyntheticScriptPlan,
} from '@/v2/public-api/synthetic-script-plan-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseCreateSyntheticScriptPlanBody(raw)
    const services = createSyntheticScriptPlanServices()
    const created = await services.createPlan({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: body.projectVersionId,
      profileSnapshotId: body.profileSnapshotId,
      locale: body.locale,
      scriptText: body.scriptText,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    const generations = await services.ensure({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: body.projectVersionId,
      planId: created.plan.head.id,
      use: body.use,
      market: body.market,
      actor,
    })
    return NextResponse.json(
      presentSuccess({ plan: presentSyntheticScriptPlan(created.plan), generations: presentBlockGenerationOutcomes(generations), replayed: created.replayed }),
      { status: created.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
