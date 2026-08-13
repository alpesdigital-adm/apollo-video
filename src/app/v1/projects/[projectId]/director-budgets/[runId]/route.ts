import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { directorBudgetService } from '@/v2/application/director-budgets'
import { createDirectorBudgetRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentDirectorBudget } from '@/v2/public-api/director-budget-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; runId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, runId } = await context.params
    const budget = await directorBudgetService({
      repository: createDirectorBudgetRepository(),
      createId: (kind) => `unused-${kind}`,
    }).get({ workspaceId: actor.workspaceId, projectId, runId })
    return NextResponse.json(
      presentSuccess({ budget: presentDirectorBudget(budget) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
