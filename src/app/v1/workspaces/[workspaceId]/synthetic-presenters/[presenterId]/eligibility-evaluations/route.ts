import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError, assertDomain } from '@/v2/domain/errors'
import { evaluateSyntheticPresenterPolicy } from '@/v2/domain/synthetic-presenter-policy-engine'
import { createSyntheticProductionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseEligibilityBody, presentEligibility } from '@/v2/public-api/synthetic-presenter-lifecycle-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string; presenterId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { workspaceId, presenterId } = await context.params
    requireScope(actor, 'projects:read')
    assertDomain(actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Eligibility actor does not belong to workspace')
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseEligibilityBody(raw)
    const repository = createSyntheticProductionRepository()
    const head = await repository.readProfileHead({ workspaceId, profileId: presenterId })
    if (!head) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic presenter profile was not found')
    const target = body.profileVersion === undefined
      ? head.current
      : await repository.readProfile({ workspaceId, snapshotId: `${presenterId}:v${body.profileVersion}` })
    if (!target) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic presenter profile version was not found')
    const decision = evaluateSyntheticPresenterPolicy({
      snapshot: target.snapshot,
      snapshotWorkspaceId: workspaceId,
      head: { currentVersion: head.head.currentVersion, current: head.current.snapshot },
      context: {
        operation: body.operation,
        use: body.use,
        market: body.market,
        locale: body.locale,
        workspaceId,
        now: new Date(),
        ...(body.requireActiveVersion !== undefined ? { requireActiveVersion: body.requireActiveVersion } : {}),
      },
    })
    return NextResponse.json(
      presentSuccess(presentEligibility(decision, target.snapshot)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
