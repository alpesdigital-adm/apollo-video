import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWebhookEndpointService } from '@/v2/application/read-webhook-administration'
import { createWebhookAdministrationQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookEndpointDetail } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ endpointId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const { endpointId } = await context.params
    const read = readWebhookEndpointService({ repository: createWebhookAdministrationQueryRepository() })
    const endpoint = await read({ workspaceId: actor.workspaceId, endpointId })
    return NextResponse.json(presentSuccess({ endpoint: presentWebhookEndpointDetail(endpoint) }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
