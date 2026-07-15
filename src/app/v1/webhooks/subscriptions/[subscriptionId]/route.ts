import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWebhookSubscriptionService } from '@/v2/application/read-webhook-administration'
import { createWebhookAdministrationQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookSubscription } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ subscriptionId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const { subscriptionId } = await context.params
    const read = readWebhookSubscriptionService({ repository: createWebhookAdministrationQueryRepository() })
    const subscription = await read({ workspaceId: actor.workspaceId, subscriptionId })
    return NextResponse.json(presentSuccess({ subscription: presentWebhookSubscription(subscription) }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
