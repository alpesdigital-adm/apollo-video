import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listWebhookSubscriptionsService } from '@/v2/application/list-webhook-administration'
import { DomainError } from '@/v2/domain/errors'
import { createWebhookAdministrationQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookSubscription } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const params = request.nextUrl.searchParams
    const allowed = new Set(['limit', 'after', 'status', 'endpointId'])
    for (const name of params.keys()) if (!allowed.has(name)) throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
    for (const name of allowed) if (params.getAll(name).length > 1) throw new DomainError('INVALID_ARGUMENT', `${name} cannot be repeated`)
    const list = listWebhookSubscriptionsService({ repository: createWebhookAdministrationQueryRepository() })
    const result = await list({
      workspaceId: actor.workspaceId,
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
      ...(params.has('after') ? { after: params.get('after') ?? '' } : {}),
      ...(params.has('status') ? { status: params.get('status') ?? '' } : {}),
      ...(params.has('endpointId') ? { endpointId: params.get('endpointId') ?? '' } : {}),
    })
    return NextResponse.json(presentSuccess({
      subscriptions: result.subscriptions.map(presentWebhookSubscription),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
