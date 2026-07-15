import { NextRequest, NextResponse } from 'next/server'

import { activateWebhookSigningSecretRotationService } from '@/v2/application/activate-webhook-signing-secret-rotation'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { webhookEndpointRevision } from '@/v2/domain/webhook'
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
    const activate = activateWebhookSigningSecretRotationService({
      repository: createWebhookSigningSecretRotationRepository(),
      clock: () => new Date(),
    })
    const result = await activate({
      workspaceId: actor.workspaceId,
      endpointId,
      rotationId,
      actorClientId: actor.clientId,
      baseRevision: body.baseRevision,
    })
    return NextResponse.json(presentSuccess({
      endpoint: {
        id: result.endpoint.id,
        status: result.endpoint.status,
        revision: webhookEndpointRevision(result.endpoint),
      },
      rotation: {
        id: result.rotation.id,
        status: result.rotation.status,
        candidateVersion: result.rotation.candidateVersion,
        fingerprint: result.rotation.fingerprint,
        overlapSeconds: result.rotation.overlapSeconds,
        activatedAt: result.rotation.activatedAt,
        overlapUntil: result.rotation.overlapUntil,
      },
      signing: {
        activeVersion: result.activatedSecret.version,
        activeFingerprint: result.activatedSecret.fingerprint,
        previousVersion: result.previousSecret.version,
        previousFingerprint: result.previousSecret.fingerprint,
        previousUsableUntil: result.previousSecret.usableUntil,
      },
      replayed: result.replayed,
    }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
