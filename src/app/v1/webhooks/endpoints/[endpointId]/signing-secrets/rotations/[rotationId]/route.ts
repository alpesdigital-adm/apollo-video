import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWebhookSigningSecretRotationService } from '@/v2/application/read-webhook-administration'
import { createWebhookAdministrationQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookSigningSecretRotation } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ endpointId: string; rotationId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const { endpointId, rotationId } = await context.params
    const read = readWebhookSigningSecretRotationService({ repository: createWebhookAdministrationQueryRepository() })
    const rotation = await read({ workspaceId: actor.workspaceId, endpointId, rotationId })
    return NextResponse.json(presentSuccess({
      rotation: presentWebhookSigningSecretRotation(rotation),
    }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
