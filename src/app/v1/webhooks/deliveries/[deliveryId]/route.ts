import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWebhookDeliveryService } from '@/v2/application/read-webhook-delivery'
import { createWebhookDeliveryQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookDeliveryDiagnostic } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ deliveryId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const { deliveryId } = await context.params
    const read = readWebhookDeliveryService({
      deliveries: createWebhookDeliveryQueryRepository(),
    })
    const diagnostic = await read({ workspaceId: actor.workspaceId, deliveryId })
    return NextResponse.json(
      presentSuccess({ delivery: presentWebhookDeliveryDiagnostic(diagnostic) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
