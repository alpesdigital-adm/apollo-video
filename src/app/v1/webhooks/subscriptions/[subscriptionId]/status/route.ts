import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { setWebhookSubscriptionStatusService } from '@/v2/application/set-webhook-subscription-status'
import { DomainError } from '@/v2/domain/errors'
import { createWebhookSubscriptionCommandRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookSubscription } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function parseBody(value: unknown): { status: string; baseRevision: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be a JSON object')
  }
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).sort().join(',') !== 'baseRevision,status' ||
    typeof body.status !== 'string' ||
    typeof body.baseRevision !== 'string'
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must contain status and baseRevision')
  }
  return { status: body.status, baseRevision: body.baseRevision }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ subscriptionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const { subscriptionId } = await context.params
    const setStatus = setWebhookSubscriptionStatusService({
      repository: createWebhookSubscriptionCommandRepository(),
    })
    const result = await setStatus({
      workspaceId: actor.workspaceId,
      subscriptionId,
      ...parseBody(body),
    })
    return NextResponse.json(
      presentSuccess({ subscription: presentWebhookSubscription(result.subscription) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
