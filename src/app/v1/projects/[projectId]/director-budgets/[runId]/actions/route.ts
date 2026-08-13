import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { directorBudgetService } from '@/v2/application/director-budgets'
import { DomainError } from '@/v2/domain/errors'
import { createDirectorBudgetRepository } from '@/v2/infrastructure/repository-factory'
import {
  assertExternalMutationOrigin,
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseDirectorBudgetActionBody,
  presentDirectorBudgetMutation,
} from '@/v2/public-api/director-budget-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; runId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    assertExternalMutationOrigin(request, actor)
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseDirectorBudgetActionBody(raw)
    const { projectId, runId } = await context.params
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    const budgets = directorBudgetService({
      repository: createDirectorBudgetRepository(),
      createId: (kind) => `director-${kind}-${randomUUID()}`,
    })
    const shared = { workspaceId: actor.workspaceId, projectId, runId, expectedRevision: body.expectedRevision, actor, idempotencyKey }
    const result = body.action === 'reserve'
      ? await budgets.reserve({ ...shared, operationKind: body.operationKind, estimate: body.estimate })
      : body.action === 'settle'
        ? await budgets.settle({ ...shared, reservationId: body.reservationId, actual: body.actual, outcome: body.outcome, ...(body.candidateResult ? { candidateResult: body.candidateResult } : {}) })
        : body.action === 'cancel-run'
          ? await budgets.cancel(shared)
          : await budgets.conclude(shared)
    return NextResponse.json(
      presentSuccess(presentDirectorBudgetMutation(result)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
