import { randomUUID } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { stageWebhookSigningSecretRotationService } from '@/v2/application/stage-webhook-signing-secret-rotation'
import { DomainError } from '@/v2/domain/errors'
import {
  createConfiguredWebhookSigningSecretProtector,
  createWebhookSigningSecretRotationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ endpointId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    let body: { baseRevision?: unknown; overlapSeconds?: unknown }
    try { body = await request.json() as typeof body } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'baseRevision,overlapSeconds' || typeof body.baseRevision !== 'string' || typeof body.overlapSeconds !== 'number') {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must contain only baseRevision and overlapSeconds')
    }
    const { endpointId } = await context.params
    const stage = stageWebhookSigningSecretRotationService({
      repository: createWebhookSigningSecretRotationRepository(),
      secrets: createConfiguredWebhookSigningSecretProtector(),
      clock: () => new Date(),
      createId: () => randomUUID(),
    })
    const result = await stage({
      workspaceId: actor.workspaceId,
      endpointId,
      actorClientId: actor.clientId,
      baseRevision: body.baseRevision,
      overlapSeconds: body.overlapSeconds,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(presentSuccess({
      rotation: {
        id: result.rotation.id,
        endpointId: result.rotation.endpointId,
        candidateVersion: result.rotation.candidateVersion,
        fingerprint: result.rotation.fingerprint,
        status: result.rotation.status,
        overlapSeconds: result.rotation.overlapSeconds,
        createdAt: result.rotation.createdAt,
        expiresAt: result.rotation.expiresAt,
      },
      ...(result.secretAvailable ? { secretBase64url: result.secretBase64url } : {}),
      secretAvailable: result.secretAvailable,
      replayed: result.replayed,
    }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
