import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listWebhookDeliveriesService } from '@/v2/application/list-webhook-deliveries'
import { DomainError } from '@/v2/domain/errors'
import { createWebhookDeliveryQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookDeliverySummary } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const params = request.nextUrl.searchParams
    const allowedParameters = new Set(['limit', 'after', 'status', 'endpointId', 'eventId'])
    for (const name of params.keys()) {
      if (!allowedParameters.has(name)) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
      }
    }
    for (const name of allowedParameters) {
      if (params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} cannot be repeated`)
      }
    }
    const rawLimit = params.get('limit')
    const list = listWebhookDeliveriesService({
      deliveries: createWebhookDeliveryQueryRepository(),
    })
    const result = await list({
      workspaceId: actor.workspaceId,
      ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
      ...(params.has('after') ? { after: params.get('after') ?? '' } : {}),
      ...(params.has('status') ? { status: params.get('status') ?? '' } : {}),
      ...(params.has('endpointId') ? { endpointId: params.get('endpointId') ?? '' } : {}),
      ...(params.has('eventId') ? { eventId: params.get('eventId') ?? '' } : {}),
    })
    return NextResponse.json(
      presentSuccess({
        deliveries: result.deliveries.map(presentWebhookDeliverySummary),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
