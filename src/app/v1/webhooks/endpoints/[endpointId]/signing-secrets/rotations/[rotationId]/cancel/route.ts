import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { cancelWebhookSigningSecretRotationService } from '@/v2/application/cancel-webhook-signing-secret-rotation'
import { DomainError } from '@/v2/domain/errors'
import { createWebhookSigningSecretRotationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ endpointId: string; rotationId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    let body: { baseRevision?: unknown }
    try { body = await request.json() as typeof body } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).join(',') !== 'baseRevision' || typeof body.baseRevision !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must contain only baseRevision')
    }
    const { endpointId, rotationId } = await context.params
    const cancel = cancelWebhookSigningSecretRotationService({
      repository: createWebhookSigningSecretRotationRepository(),
      clock: () => new Date(),
    })
    const result = await cancel({
      workspaceId: actor.workspaceId,
      endpointId,
      rotationId,
      actorClientId: actor.clientId,
      baseRevision: body.baseRevision,
    })
    return NextResponse.json(presentSuccess({
      rotation: {
        id: result.rotation.id,
        endpointId: result.rotation.endpointId,
        status: result.rotation.status,
        candidateVersion: result.rotation.candidateVersion,
        fingerprint: result.rotation.fingerprint,
        cancelledAt: result.rotation.cancelledAt,
      },
      envelopeDestroyed: true,
      replayed: result.replayed,
    }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
