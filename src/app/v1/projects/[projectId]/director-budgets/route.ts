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
  parseCreateDirectorBudgetBody,
  presentDirectorBudget,
  presentDirectorBudgetMutation,
} from '@/v2/public-api/director-budget-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function service() {
  return directorBudgetService({
    repository: createDirectorBudgetRepository(),
    createId: (kind) => `director-${kind}-${randomUUID()}`,
  })
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const limitRaw = request.nextUrl.searchParams.get('limit')
    const budgets = await service().list({
      workspaceId: actor.workspaceId,
      projectId,
      ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
    })
    return NextResponse.json(
      presentSuccess({ budgets: budgets.map(presentDirectorBudget) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
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
    const body = parseCreateDirectorBudgetBody(raw)
    const { projectId } = await context.params
    const result = await service().create({
      workspaceId: actor.workspaceId,
      projectId,
      runId: body.runId,
      limits: body.limits,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess(presentDirectorBudgetMutation(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
