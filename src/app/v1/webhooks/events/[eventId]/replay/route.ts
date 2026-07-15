import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createWebhookEventReplay } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentSuccess,
  presentWebhookEventReplayItem,
} from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const { eventId } = await context.params
    const replay = createWebhookEventReplay()
    const result = await replay({
      workspaceId: actor.workspaceId,
      clientId: actor.clientId,
      eventId,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        eventId: result.eventId,
        items: result.items.map(presentWebhookEventReplayItem),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 202,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
