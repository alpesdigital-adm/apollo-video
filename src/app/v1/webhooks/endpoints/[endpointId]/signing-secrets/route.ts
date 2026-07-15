import { randomUUID } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { provisionWebhookSigningSecretService } from '@/v2/application/provision-webhook-signing-secret'
import { readWebhookEndpointService } from '@/v2/application/read-webhook-administration'
import { DomainError } from '@/v2/domain/errors'
import {
  createConfiguredWebhookSigningSecretProtector,
  createWebhookAdministrationQueryRepository,
  createWebhookSigningSecretProvisioningRepository,
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
    let body: { baseRevision?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'baseRevision' ||
      typeof body.baseRevision !== 'string'
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must contain only baseRevision',
      )
    }
    const { endpointId } = await context.params
    const provision = provisionWebhookSigningSecretService({
      repository: createWebhookSigningSecretProvisioningRepository(),
      secrets: createConfiguredWebhookSigningSecretProtector(),
      clock: () => new Date(),
      createId: () => randomUUID(),
    })
    const result = await provision({
      workspaceId: actor.workspaceId,
      endpointId,
      actorClientId: actor.clientId,
      baseRevision: body.baseRevision,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    const read = readWebhookEndpointService({
      repository: createWebhookAdministrationQueryRepository(),
    })
    const endpoint = await read({ workspaceId: actor.workspaceId, endpointId })
    return NextResponse.json(
      presentSuccess({
        endpoint: presentWebhookEndpointSummary(endpoint),
        ...(result.secretAvailable
          ? { secretBase64url: result.secretBase64url }
          : {}),
        secretAvailable: result.secretAvailable,
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
