import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createWebhookEndpointService } from '@/v2/application/create-webhook-endpoint'
import { listWebhookEndpointsService } from '@/v2/application/list-webhook-administration'
import { DomainError } from '@/v2/domain/errors'
import {
  createConfiguredWebhookSigningSecretProtector,
  createWebhookAdministrationQueryRepository,
  createWebhookEndpointCreationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess, presentWebhookEndpointSummary } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const params = request.nextUrl.searchParams
    const allowed = new Set(['limit', 'after', 'status'])
    for (const name of params.keys()) if (!allowed.has(name)) throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
    for (const name of allowed) if (params.getAll(name).length > 1) throw new DomainError('INVALID_ARGUMENT', `${name} cannot be repeated`)
    const list = listWebhookEndpointsService({ repository: createWebhookAdministrationQueryRepository() })
    const result = await list({
      workspaceId: actor.workspaceId,
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
      ...(params.has('after') ? { after: params.get('after') ?? '' } : {}),
      ...(params.has('status') ? { status: params.get('status') ?? '' } : {}),
    })
    return NextResponse.json(presentSuccess({
      endpoints: result.endpoints.map(presentWebhookEndpointSummary),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let body: Record<string, unknown>
    try {
      const value = await request.json() as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
      }
      body = value as Record<string, unknown>
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    for (const name of Object.keys(body)) {
      if (name !== 'url') throw new DomainError('INVALID_ARGUMENT', `${name} is not supported`)
    }
    if (typeof body.url !== 'string') throw new DomainError('INVALID_ARGUMENT', 'url must be a string')

    const createEndpoint = createWebhookEndpointService({
      repository: createWebhookEndpointCreationRepository(),
      secrets: createConfiguredWebhookSigningSecretProtector(),
      clock: () => new Date(),
      createId: (kind) => kind === 'idempotency-record'
        ? `${kind}-${randomUUID()}`
        : randomUUID(),
    })
    const result = await createEndpoint({
      workspaceId: actor.workspaceId,
      url: body.url,
      createdByClientId: actor.clientId,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        endpoint: presentWebhookEndpointSummary({
          endpoint: result.endpoint,
          currentSecret: result.secret,
        }),
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
