import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWebhookEndpointService } from '@/v2/application/read-webhook-administration'
import { DomainError } from '@/v2/domain/errors'
import {
  createWebhookAdministrationQueryRepository,
  createWebhookEndpointActivator,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookEndpointSummary } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ endpointId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const contentLength = request.headers.get('content-length')?.trim()
    if (request.headers.has('content-type') || (contentLength && contentLength !== '0')) {
      throw new DomainError('INVALID_ARGUMENT', 'Webhook challenge does not accept a request body')
    }
    const { endpointId } = await context.params
    const activate = createWebhookEndpointActivator(process.env, () => new Date())
    const activation = await activate({ workspaceId: actor.workspaceId, endpointId })
    const read = readWebhookEndpointService({
      repository: createWebhookAdministrationQueryRepository(),
    })
    const endpoint = await read({ workspaceId: actor.workspaceId, endpointId })
    return NextResponse.json(
      presentSuccess({
        endpoint: presentWebhookEndpointSummary(endpoint),
        effects: { activatedSubscriptions: activation.activatedSubscriptions },
        replayed: activation.replayed,
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
